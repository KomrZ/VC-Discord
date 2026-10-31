import { integrationDir } from "./platform";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import type { Settings } from "./config";
import { limitedBody } from "./providers";
import type { VoiceTransport } from "./voice";
import { findMusicFFmpeg } from "./music-setup";
import { RadioPresenter, type RadioTrack } from "./radio";

export type MusicControl = "pause" | "resume" | "stop" | "next" | "previous" | "current";

export function isHlsInput(track: { service?: unknown; stream_format?: unknown }): boolean {
  return track.stream_format ? track.stream_format === "hls" : track.service === "vk";
}

async function musicCall(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
  let location: { port: number; token: string };
  try {
    const folder = integrationDir();
    location = JSON.parse(await readFile(join(folder, "music.json"), "utf8"));
    if (!Number.isInteger(location.port) || location.port < 1 || location.port > 65535 || !/^[A-Za-z0-9_-]{32,100}$/.test(location.token)) throw new Error();
  } catch { throw new Error("Нет связи с Astra Music. Включите обновлённый музыкальный плагин в Astra."); }
  try {
    const response = await fetch(`http://127.0.0.1:${location.port}/api`, {
      method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(95000)]) : AbortSignal.timeout(95000),
      headers: { Authorization: "Bearer " + location.token, "Content-Type": "application/json" }, body: JSON.stringify({ method, params }),
    });
    if (response.status === 404) { await response.body?.cancel(); throw new Error("Перезапустите обновлённый Astra Music: музыкальный мост ещё не поддерживает Discord."); }
    const data = JSON.parse((await limitedBody(response, 500000, "Astra Music")).toString("utf8"));
    if (data.error) throw new Error("Astra Music не смогла подготовить трек. Проверьте подключение музыкального сервиса в её вкладке.");
    return data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Astra Music") || error instanceof Error && error.message.startsWith("Перезапустите")) throw error;
    throw new Error("Нет ответа от музыкального моста. Перезапустите Astra Music и повторите действие.");
  }
}

export class DiscordMusic {
  private child?: ChildProcessWithoutNullStreams;
  private pcm?: PassThrough;
  private controller?: AbortController;
  private poll?: NodeJS.Timeout;
  private epoch = 0;
  private revision = -1;
  private following = false;
  private paused = false;
  private polling = false;
  private title = "";
  private artist = "";
  private error = "";
  private selectedVolume?: number;
  private session = "";
  private loading = false;
  private service: "yandex" | "vk" | "spotify" = "yandex";
  private sourcePlaying = true;
  private spotifyStream = false;
  private job?: { id: string; status: string; result?: unknown; error?: string };
  private hlsOptions = new Map<string, string[]>();
  private bridgeVersion = 0;
  private transitioning = false;
  private recovering = false;
  private recoveryAttempts = 0;
  private resumeSeconds = 0;
  private expectedDuration = 0;
  private decoderAttached = false;
  private volumeRevision = 0;
  private readonly volumeInstance = randomBytes(16).toString("hex");
  private syncFinished: Promise<void> = Promise.resolve();
  private readonly radio: RadioPresenter;
  constructor(private transport: VoiceTransport, private settings: () => Settings, private note: (text: string, error?: boolean) => void, private trace: (text: string) => void = () => {}, private onHealthy: () => void = () => {}, announce: (track: RadioTrack, signal: AbortSignal) => Promise<void> = async () => {}) {
    this.radio = new RadioPresenter(settings, announce, text => note(text, true));
  }
  cancelRadio(): void { this.radio.cancel(); }
  private healthy(): void { this.error = ""; this.onHealthy(); }
  state(): Record<string, unknown> { return { following: this.following, service: this.service, loading: this.loading || this.transitioning || this.recovering, recovering: this.recovering, recoveryAttempts: this.recoveryAttempts, paused: this.paused, title: this.title, artist: this.artist, error: this.error, playing: !!this.child && !this.paused && !this.recovering && this.sourcePlaying, volume: this.selectedVolume ?? this.settings().musicVolume, volumeRevision: this.volumeRevision, volumeInstance: this.volumeInstance, audio: this.transport.musicStats(), job: this.job }; }
  beginJob(method: "search" | "playlists" | "play" | "next", value: unknown = {}): unknown {
    if (method === "next" || method === "play") this.trace(`music_button action=${method}`);
    if (this.job?.status === "loading") throw new Error("Дождитесь завершения музыкального действия.");
    const job = { id: randomBytes(16).toString("hex"), status: "loading" } as NonNullable<typeof this.job>;
    this.job = job;
    void (async () => {
      try { job.result = await (method === "search" ? this.search(value) : method === "playlists" ? this.playlists(value) : method === "next" ? this.next(false, Number((value as any)?.direction) || 1) : this.play(value)); job.status = "done"; }
      catch (error) { job.error = error instanceof Error ? error.message : "Музыкальное действие не выполнено."; job.status = "failed"; this.note(job.error, true); }
    })();
    return { ok: true, jobId: job.id };
  }
  async current(): Promise<unknown> {
    const track = await musicCall("current");
    return { track: { service: track.service, track_id: track.track_id, title: track.title, artist: track.artist } };
  }
  async search(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const input = value as any;
    const query = String(input?.query || "").trim().slice(0, 200);
    if (!query) throw new Error("Введите название трека или исполнителя.");
    this.service = input?.service === "spotify" ? "spotify" : input?.service === "vk" ? "vk" : "yandex";
    const result = await musicCall("search", { service: this.service, query, limit: 10 }, signal); this.healthy(); return result;
  }
  async playlists(value: unknown): Promise<any> { this.service = (value as any)?.service === "spotify" ? "spotify" : (value as any)?.service === "vk" ? "vk" : "yandex"; const result = await musicCall("discord_playlists", { service: this.service }); this.healthy(); return result; }
  async like(): Promise<string> {
    if (!this.following || !this.session || this.revision < 0 || this.recovering || this.transitioning) return "Сначала включите песню в Discord и дождитесь загрузки.";
    if (this.bridgeVersion < 5) return "Для лайков обновите Astra Music до актуальной версии (не ниже 1.3.0) и перезапустите оба плагина.";
    const epoch = this.epoch;
    const result = await musicCall("discord_like", { session: this.session, revision: this.revision }, this.controller?.signal);
    if (epoch !== this.epoch || result.cancelled) return "Песня изменилась; повторите команду лайка.";
    if (result.unsupported) return "Лайк доступен только для Яндекс Музыки.";
    if (result.liked !== true) throw new Error("Astra Music не подтвердила сохранение лайка.");
    this.healthy(); return "Песня добавлена в понравившиеся Яндекс Музыки.";
  }
  async play(value?: unknown): Promise<unknown> {
    if (!this.transport.connected) throw new Error("Подключите бота к голосовому каналу.");
    this.stop();
    const epoch = this.epoch;
    this.controller = new AbortController();
    this.session = randomBytes(16).toString("hex"); this.loading = true;
    const input = value as any;
    try {
      const provider = input?.service || (!input?.track_id ? (await musicCall('current')).service : 'yandex');
      this.service = provider === "spotify" ? "spotify" : provider === "vk" ? "vk" : "yandex";
      await musicCall("discord_play", { session: this.session, service: this.service, mode: ["wave", "library", "playlist"].includes(input?.mode) ? input.mode : "track", playlist_id: String(input?.playlist_id || "").slice(0, 200), track_id: String(input?.track_id || "").slice(0, 100), title: String(input?.title || "").slice(0, 200), artist: String(input?.artist || "").slice(0, 200), extra: input?.extra && typeof input.extra === "object" ? input.extra : {} }, this.controller.signal);
      if (epoch !== this.epoch) return { ok: true, cancelled: true };
      this.following = true; this.error = "";
      await this.sync();
      if (epoch === this.epoch) this.loading = false;
    } catch (error) { if (epoch !== this.epoch) return { ok: true, cancelled: true }; this.stop(); throw error; }
    if (epoch !== this.epoch || !this.following) return { ok: true, cancelled: true };
    this.poll = setInterval(() => { void this.sync().catch(() => { if (!this.following || this.epoch !== epoch) return; this.stop(); this.error = "Связь с Astra Music потеряна. Подключите трансляцию заново."; this.note(this.error, true); }); }, 1500);
    return { ok: true };
  }
  async request(value: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const pending = this.play(value), epoch = this.epoch;
    const cancel = () => { if (epoch === this.epoch) this.stop(); };
    signal.addEventListener("abort", cancel, { once: true });
    try { if (signal.aborted) cancel(); return await pending; }
    finally { signal.removeEventListener("abort", cancel); }
  }
  private setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused; this.transport.pauseMusic(paused);
    if (paused) this.radio.cancel();
    if (this.following) this.transport.musicPresence(this.title, this.artist, this.service, paused);
  }
  pause(): { ok: true } { this.setPaused(!this.paused); return { ok: true }; }
  async control(action: MusicControl, allowed: () => boolean, signal: AbortSignal): Promise<string> {
    if (signal.aborted || !allowed()) throw new Error("Музыкальная команда отменена.");
    if (action === "current") return this.following && this.title ? `${this.paused ? "На паузе" : "Сейчас играет"}: ${this.artist ? this.artist + " — " : ""}${this.title}.` : "Сейчас музыка в Discord не играет.";
    if (!this.following && !this.loading) throw new Error("Сейчас музыка в Discord не включена. Закажите песню: !play исполнитель — название.");
    if (action === "stop") { this.stop(); return "Музыка в Discord остановлена."; }
    if (this.loading || this.transitioning || this.recovering || this.job?.status === "loading") throw new Error("Дождитесь завершения музыкального действия.");
    if (action === "pause" || action === "resume") {
      this.setPaused(action === "pause");
      return action === "pause" ? "Музыка в Discord на паузе." : "Продолжаю музыку в Discord.";
    }
    const epoch = this.epoch;
    // Cancel only this music session, never a newer owner/scheduled session.
    const cancel = () => { if (epoch === this.epoch) this.stop(); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.next(false, action === "previous" ? -1 : 1, () => allowed() && !signal.aborted) as { cancelled?: boolean; pending?: boolean; ended?: boolean };
      if (signal.aborted || !allowed() || result.cancelled) throw new Error("Музыкальная команда отменена.");
      if (result.pending) throw new Error("Дождитесь завершения музыкального действия.");
      if (result.ended) return "Очередь закончилась. Музыка в Discord остановлена.";
      if (!this.following) throw new Error("Не удалось продолжить музыку. Закажите песню заново: !play исполнитель — название.");
      return this.title ? `Переключила трек: ${this.artist ? this.artist + " — " : ""}${this.title}.${this.paused ? " Музыка остаётся на паузе." : ""}` : "Трек переключён.";
    } finally { signal.removeEventListener("abort", cancel); }
  }
  volume(value: unknown): { ok: true; volumeRevision: number } {
    const input = value as any;
    // Keep old percent calls working; the current UI and voice use level 0–10.
    const volume = input?.level !== undefined ? Number(input.level) * 10 : Number(input?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error("Громкость должна быть от 0 до 10.");
    this.selectedVolume = volume; this.volumeRevision++; this.transport.musicVolume(volume); return { ok: true, volumeRevision: this.volumeRevision };
  }
  stop(): { ok: true } {
    this.radio.reset();
    const session = this.session; this.session = ""; this.loading = false;
    if (session) void musicCall("discord_stop", { session }).catch(() => {});
    this.following = false; this.epoch++; this.controller?.abort(); this.controller = undefined;
    this.recovering = false; this.recoveryAttempts = 0; this.resumeSeconds = 0; this.expectedDuration = 0;
    if (this.poll) clearInterval(this.poll); this.poll = undefined;
    this.stopDecoder(); this.transport.stopMusic(); this.revision = -1; this.title = ""; this.artist = ""; this.paused = false;
    return { ok: true };
  }
  private stopDecoder(): void { const child = this.child; this.child = undefined; this.decoderAttached = false; this.pcm?.destroy(); this.pcm = undefined; child?.stdout.destroy(); child?.stdin.destroy(); child?.kill(); }
  private position(): number {
    const bytes = this.decoderAttached ? Number((this.transport.musicStats() as { musicBytes?: number }).musicBytes) || 0 : 0;
    return this.resumeSeconds + bytes / 192000;
  }
  private requestRecovery(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.child !== child || this.recovering || !this.following) return;
    const epoch = this.epoch, signal = this.controller?.signal;
    if (!signal || signal.aborted) return;
    const position = this.position();
    this.recovering = true; this.error = "";
    this.note("Поток прервался. Восстанавливаю текущую песню с места остановки…");
    this.trace(`music_recovery reason=${reason} position_seconds=${position.toFixed(2)} revision=${this.revision}`);
    void (async () => {
      let restored = false;
      try {
        await this.syncFinished;
        if (epoch !== this.epoch || signal.aborted) return;
        this.stopDecoder(); this.transport.stopMusic(); this.resumeSeconds = position;
        while (this.recoveryAttempts < 3 && epoch === this.epoch && !signal.aborted) {
          this.recoveryAttempts++;
          this.trace(`music_recovery attempt=${this.recoveryAttempts} position_seconds=${position.toFixed(2)} revision=${this.revision}`);
          try {
            await new Promise<void>((resolve, reject) => {
              const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Восстановление отменено.")); };
              const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000 * this.recoveryAttempts);
              signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
            });
            if (this.bridgeVersion >= 4) {
              const result = await musicCall("discord_refresh", { session: this.session, revision: this.revision }, signal);
              if (epoch !== this.epoch || signal.aborted) return;
              if (result.cancelled) throw new Error("Текущая очередь изменилась.");
            }
            this.revision = -1;
            await this.sync(true, true);
            if (epoch !== this.epoch || signal.aborted || !this.following) return;
            if (!this.child || !this.decoderAttached) throw new Error("Декодер не восстановлен.");
            restored = true; this.error = "";
            this.note("Музыка восстановлена; продолжаю текущую песню.");
            return;
          } catch {
            if (epoch !== this.epoch || signal.aborted) return;
            this.stopDecoder(); this.transport.stopMusic();
            // A refresh can commit a revision before its response is lost.
            // Re-read it so the next attempt addresses the actual current entry.
            try { const current = await musicCall("discord_state", { session: this.session }, signal); if (epoch === this.epoch) this.revision = Number(current.revision); } catch {}
          }
        }
      } finally {
        if (epoch === this.epoch) this.recovering = false;
      }
      if (restored || epoch !== this.epoch || signal.aborted || !this.following) return;
      this.note("Три попытки восстановления не помогли. Перехожу к следующей песне.");
      this.trace("music_recovery exhausted; skipping current track");
      try {
        const result = await this.next(false) as { cancelled?: boolean; ended?: boolean };
        if (epoch === this.epoch && result.cancelled) {
          this.stop(); this.error = "[MUSIC_RECOVERY_EXHAUSTED] Очередь недоступна после обрыва. Проверьте подключение сервиса в Astra Music и включите музыку заново."; this.note(this.error, true);
        } else if (result.ended) this.note("Песню восстановить не удалось; очередь закончилась.");
      } catch { /* next() reports a bridge error with a user-facing explanation. */ }
    })().catch(() => { if (epoch === this.epoch && !signal.aborted) { this.stop(); this.error = "Не удалось восстановить музыку. Проверьте подключение Astra Music."; this.note(this.error, true); } });
  }
  async next(finished = false, direction = 1, allowed: () => boolean = () => true): Promise<unknown> {
    if (!allowed()) return { ok: true, cancelled: true };
    if (!this.following || !this.session) return { ok: true };
    if (this.transitioning || this.recovering) return { ok: true, pending: true };
    this.transitioning = true;
    this.radio.cancel();
    this.trace(`music_transition source=${finished ? "stream_end" : "command"} direction=${direction < 0 ? -1 : 1} revision=${this.revision}`);
    const epoch = this.epoch;
    const playedSeconds = this.position();
    try {
      await this.syncFinished;
      if (epoch !== this.epoch) return { ok: true, cancelled: true };
      if (!allowed()) return { ok: true, cancelled: true };
      if (!this.spotifyStream) { this.stopDecoder(); this.transport.stopMusic(); }
      const params: Record<string, unknown> = { session: this.session, revision: this.revision, direction, finished };
      // Earlier running Music instances do not accept this optional argument.
      // Negotiate it from state rather than assuming a source file was reloaded.
      if (this.bridgeVersion >= 2) params.played_seconds = playedSeconds;
      const result = await musicCall("discord_next", params, this.controller?.signal);
      if (epoch !== this.epoch) return { ok: true, cancelled: true };
      if (!allowed()) { this.stop(); return { ok: true, cancelled: true }; }
      if (result.status === "stopped") { this.stop(); return { ok: true, ended: true }; }
      if (result.cancelled) return { ok: true, cancelled: true };
      this.error = "";
      if (this.spotifyStream) await this.sync(true);
      else { this.revision = -1; await this.sync(true); }
      if (epoch !== this.epoch) return { ok: true, cancelled: true };
      if (!allowed()) { this.stop(); return { ok: true, cancelled: true }; }
      return { ok: true };
    } catch (error) {
      if (!allowed()) { if (epoch === this.epoch) this.stop(); return { ok: true, cancelled: true }; }
      if (epoch === this.epoch) {
        this.stop(); this.error = "Не удалось включить следующий трек.";
        this.note(this.error, true);
      }
      throw error;
    } finally { this.transitioning = false; }
  }
  async voice(text: string, allowed: () => boolean, signal: AbortSignal): Promise<string | undefined> {
    let phrase = text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[.,!?;:]/g, " ").trim()
      .replace(/^(?:астра|астр|остра)\s+/, "").replace(/\s+/g, " ");
    const spotifyRequest = /(?:\s+(?:в|из|на))?\s+(?:spotify|спотифай|спотифи)$/u.test(phrase);
    if (spotifyRequest) phrase = phrase.replace(/(?:\s+(?:в|из|на))?\s+(?:spotify|спотифай|спотифи)$/u, '').trim();
    const likeRequest = /^(?:лайк|лайкни(?: (?:песню|трек|эту песню|этот трек|текущую песню|текущий трек))?|поставь лайк(?: (?:песне|треку|песню|трек))?|добавь (?:песню|трек|эту песню|этот трек) в (?:понравившиеся|избранное)|мне нравится (?:эта песня|этот трек))$/u.test(phrase);
    const mixRequest = /^(?:включи|поставь|запусти) (?:мой |мою |персональный |ежедневный )?микс$/u.test(phrase);
    const control = likeRequest || mixRequest || /^(?:пауза(?: музыки)?|останови музыку|выключи музыку|продолжи музыку|возобнови музыку|следующ(?:ий|ая) (?:трек|песня)|предыдущ(?:ий|ая) (?:трек|песня)|(?:сделай |музыку )?(?:громче|тише)(?: музыку)?|(?:громкость|громкость музыки|установи громкость|сделай громкость|сделай громкость музыки) .+|(?:включи|поставь|запусти) (?:музыку|музыку в дискорде|мою волну|моя волна|мои треки (?:вк|vk)|плейлист .+|(?:песню|трек|музыку) .+)|найди (?:песню|трек|музыку) .+)$/u.test(phrase);
    if (!control) return undefined;
    if (!allowed()) return "У этого аккаунта нет доступа к управлению музыкой.";
    if (spotifyRequest) this.service='spotify';
    signal.throwIfAborted();
    if (likeRequest) return this.like();
    if ((this.loading || this.transitioning || this.recovering || this.job?.status === "loading") && phrase !== "выключи музыку" && phrase !== "останови музыку") return "Дождитесь завершения музыкального действия.";
    if (/^пауза/u.test(phrase)) { this.setPaused(true); return "Музыка на паузе."; }
    if (phrase === "выключи музыку" || phrase === "останови музыку") { this.stop(); return "Музыка остановлена."; }
    if (/^(?:продолжи|возобнови) музыку$/u.test(phrase)) { this.setPaused(false); return "Продолжаю музыку."; }
    if (/^(?:следующ|предыдущ)/u.test(phrase)) { this.trace("music_voice action=next"); await this.next(false, phrase.startsWith("предыдущ") ? -1 : 1); return "Переключаю трек."; }
    if (/громче|тише/u.test(phrase)) { this.volume({ level: Math.max(0, Math.min(10, (this.selectedVolume ?? this.settings().musicVolume) / 10 + (phrase.includes("громче") ? 1 : -1))) }); return "Громкость " + (this.selectedVolume! / 10) + " из десяти."; }
    if (phrase.includes("громкость")) {
      const words: Record<string, number> = { ноль: 0, один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100 };
      const amount = phrase.slice(phrase.lastIndexOf("громкость") + 9).replace(/^(?: музыки)?\s*(?:на\s+)?/u, "").replace(/\s*(?:процент(?:ов|а)?|%)$/u, "").trim();
      const parts = amount.split(" ");
      const parsed = /^\d{1,3}$/.test(amount) ? Number(amount) : parts.length <= 2 && parts.every(p => words[p] !== undefined) ? parts.reduce((sum, p) => sum + words[p], 0) : NaN;
      const level = /(?:процент(?:ов|а)?|%)$/u.test(phrase) ? parsed / 10 : parsed;
      if (!Number.isFinite(level) || level < 0 || level > 10) return "Назовите громкость от нуля до десяти.";
      this.volume({ level }); return "Громкость " + level + " из десяти.";
    }
    let input: any;
    if (/^(?:включи|поставь|запусти) музыку(?: в дискорде)?$/u.test(phrase)) input = spotifyRequest ? {service:'spotify'} : {};
    else if (/мо[юя] волн[уа]$/u.test(phrase)) input = { mode: "wave", service: spotifyRequest ? "spotify" : "yandex" };
    else if (mixRequest) input = { mode: "wave", service: "spotify" };
    else if (/мои треки (?:вк|vk)$/u.test(phrase)) input = { mode: "library", service: "vk" };
    else if (phrase.includes("плейлист ")) {
      const wanted = phrase.split("плейлист ")[1];
      const data = await this.playlists({ service: this.service });
      const list = (data.playlists || []).filter((p: any) => String(p.title || "").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[.,!?;:]/g, " ").replace(/\s+/g, " ").trim() === wanted);
      if (list.length !== 1) return list.length ? "Есть несколько таких плейлистов. Выберите нужный во вкладке плагина." : "Плейлист с таким названием не найден.";
      input = { mode: "playlist", service: this.service, playlist_id: list[0].playlist_id };
    } else {
      const query = phrase.replace(/^(?:включи|поставь|запусти|найди) (?:песню|трек|музыку) /u, "");
      const data = await this.search({ service: this.service, query }) as any;
      input = data.tracks?.[0];
      if (!input) return "Не нашла такой трек. Попробуйте назвать исполнителя и песню.";
    }
    if (signal.aborted || !allowed()) return "Управление музыкой отменено.";
    const abort = () => this.stop(); signal.addEventListener("abort", abort, { once: true });
    let result: any;
    try { this.trace("music_voice action=play"); result = await this.play(input); }
    finally { signal.removeEventListener("abort", abort); }
    return signal.aborted || result?.cancelled ? undefined : "Включаю " + (this.title || "музыку") + " в Discord.";
  }
  private async decoderHlsOptions(executable: string): Promise<string[]> {
    const cached = this.hlsOptions.get(executable);
    if (cached) return cached;
    const help = await new Promise<string>(resolve => execFile(executable, ["-hide_banner", "-h", "demuxer=hls"], { windowsHide: true, timeout: 5000, maxBuffer: 32000 }, (error, stdout) => resolve(error ? "" : stdout)));
    const options = ["-allowed_extensions", "ALL"];
    if (help.includes("allowed_segment_extensions")) options.push("-allowed_segment_extensions", "ALL");
    if (help.includes("extension_picky")) options.push("-extension_picky", "0");
    this.hlsOptions.set(executable, options); return options;
  }
  private async sync(transition = false, resume = false): Promise<void> {
    if (!this.following || this.polling || (this.transitioning || this.recovering) && !transition) return;
    this.polling = true;
    let finished!: () => void;
    this.syncFinished = new Promise<void>(resolve => { finished = resolve; });
    const epoch = this.epoch;
    try {
      const radioSettings = this.settings();
      const wantNext = radioSettings.radioEnabled && radioSettings.radioNext && !this.paused && (radioSettings.radioWhen === "start" || !this.expectedDuration || this.position() >= this.expectedDuration - 35);
      let track = await musicCall("discord_state", { session: this.session, ...(this.bridgeVersion >= 6 ? { want_next: wantNext } : {}) }, this.controller?.signal);
      if (wantNext && this.bridgeVersion < 6 && Number(track.bridge_version) >= 6) {
        track = await musicCall("discord_state", { session: this.session, want_next: true }, this.controller?.signal);
      }
      if (epoch !== this.epoch || !this.following || (this.transitioning || this.recovering) && !transition) return;
      this.bridgeVersion = Number(track.bridge_version) || 0;
      if (this.revision < 0 && this.bridgeVersion < 4) this.note("Для обновления ссылки при обрыве музыки обновите Astra Music до актуальной версии (не ниже 1.3.0) и перезапустите оба плагина.");
      if (!this.transport.connected) { this.stop(); return; }
      this.title = String(track.title || ""); this.artist = String(track.artist || "");
      this.service = track.service === "spotify" ? "spotify" : track.service === "vk" ? "vk" : "yandex";
      this.sourcePlaying = track.service !== 'spotify' || track.spotify_status === 'playing';
      this.spotifyStream = track.service === 'spotify' && track.codec === 'pcm_s16le';
      if (!track.stream_url || ["stopped", "failed", "idle"].includes(track.status)) { this.stop(); return; }
      if (track.revision !== this.revision) {
        if (!resume) { this.resumeSeconds = 0; this.expectedDuration = 0; this.recoveryAttempts = 0; }
        const url = new URL(track.stream_url);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]{32,100}\/discord-stream\/\d+\/0$/.test(url.pathname)) throw new Error("Неверный адрес музыкального потока.");
        const executable = await findMusicFFmpeg(this.settings().musicFFmpeg);
        if (!executable) throw new Error("FFmpeg не найден. Нажмите «Подготовить музыку» во вкладке «Музыка».");
        if (epoch !== this.epoch) return;
        this.stopDecoder(); this.revision = track.revision;
        // FFmpeg can read HLS playlists, segments and AES keys only via our
        // loopback proxy. It receives no service cookies or signed CDN URLs.
        // VK now also serves plain .mp3, whose demuxer rejects HLS options; older
        // Astra Music builds send no stream_format and only HLS for VK.
        const hlsOptions = isHlsInput(track) ? await this.decoderHlsOptions(executable) : [];
        if (epoch !== this.epoch) return;
        const resumeAt = this.resumeSeconds;
        const pcmInput = track.service === 'spotify' && track.codec === 'pcm_s16le';
        const seek = !pcmInput && resumeAt > 0 ? ["-ss", resumeAt.toFixed(3)] : [];
        const format = pcmInput ? ['-probesize','8192','-analyzeduration','0','-f','s16le','-ar','48000','-ac','2'] : [];
        const child = spawn(executable, ["-hide_banner", "-loglevel", "info", "-nostats", "-nostdin", "-rw_timeout", "25000000", "-protocol_whitelist", "http,tcp,crypto", ...hlsOptions, ...seek, ...format, "-i", url.href, "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        this.child = child;
        this.trace(`music_decoder started revision=${this.revision}`);
        const pcm = new PassThrough({ highWaterMark: 96000 }); this.pcm = pcm;
        let decodedBytes = 0, expectedSeconds = this.expectedDuration, stderr = "", streamInterrupted = false, drained = false, closed = false, completed = false;
        let exitCode: number | null = null;
        // Count decoded audio, not wall time: pauses and buffering do not shorten
        // a song. Parse fixed numeric fields only; raw logs contain signed URLs.
        child.stdout.on("data", (chunk: Buffer) => { decodedBytes += chunk.length; });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString("utf8")).slice(-8192);
          const duration = stderr.match(/Duration:\s*(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)/);
          if (duration) { const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]); if (seconds > 0 && seconds <= 86400) { expectedSeconds = seconds; this.expectedDuration = seconds; } }
          streamInterrupted ||= /Stream ends prematurely|partial file|Input\/output error|Connection timed out|Connection reset by peer|Failed to open segment|Error opening input/i.test(stderr);
        });
        child.stdout.pipe(pcm);
        const fail = (reason = "MUSIC_STREAM_FAILED") => { if (this.child !== child) return; this.trace(`music_decoder failed reason=${reason} decoded_seconds=${(resumeAt + decodedBytes / 192000).toFixed(2)} expected_seconds=${expectedSeconds.toFixed(2)}`); this.requestRecovery(child, reason); };
        const complete = () => {
          if (completed || this.child !== child || !closed || !drained) return;
          // A very short remaining tail can finish during startup. Let the
          // transition/recovery finish before advancing, otherwise next() is busy.
          if (this.recovering || this.transitioning) { setTimeout(complete, 50).unref(); return; }
          completed = true;
          const decodedSeconds = resumeAt + decodedBytes / 192000;
          const short = expectedSeconds > 0 && decodedSeconds + Math.max(5, expectedSeconds * .03) < expectedSeconds;
          // A transient HLS warning is not a lost song if all expected audio
          // arrived. Unknown duration still requires an unbroken stream.
          if (exitCode !== 0 || !decodedBytes || short || streamInterrupted && !expectedSeconds) { fail(short ? "MUSIC_EARLY_EOF" : "MUSIC_STREAM_INTERRUPTED"); return; }
          this.trace(`music_decoder completed decoded_seconds=${decodedSeconds.toFixed(2)} expected_seconds=${expectedSeconds.toFixed(2)}`);
          void this.next(true).catch(() => { if (epoch === this.epoch) fail("MUSIC_NEXT_FAILED"); });
        };
        child.on("error", () => fail()); child.stdin.on("error", () => {}); child.stdout.on("error", () => fail()); pcm.on("error", () => fail());
        child.on("close", code => {
          if (this.child !== child) return;
          closed = true; exitCode = code;
          this.trace(`music_decoder exited code=${code ?? "signal"}`);
          if (!this.decoderAttached && code !== 0) { fail(); return; }
          complete();
        });
        // EOF on stdout also happens on an error. Advance only after a successful
        // process exit AND consumption of the buffered PCM tail by Discord.
        pcm.once("end", () => { drained = true; complete(); });
        const signal = this.controller?.signal;
        try { await new Promise<void>((resolve, reject) => {
          let settled = false;
          const ready = () => { if (pcm.readableLength >= 48000 || pcm.writableFinished && pcm.readableLength > 0) finish(); };
          const failed = () => finish(new Error("Не удалось получить звук музыкального потока. Проверьте подключение сервиса в Astra Music."));
          const finish = (error?: Error) => {
            if (settled) return; settled = true;
            clearTimeout(timer); pcm.off("readable", ready); pcm.off("finish", ready); pcm.off("close", failed); child.off("close", failed); child.off("error", failed); signal?.removeEventListener("abort", failed);
            error ? reject(error) : resolve();
          };
          const timer = setTimeout(failed, 30000);
          pcm.on("readable", ready); pcm.once("finish", ready); pcm.once("close", failed); child.once("close", failed); child.once("error", failed); signal?.addEventListener("abort", failed, { once: true });
          if (signal?.aborted) failed(); else ready();
        }); } catch (error) { if (epoch !== this.epoch) return; if (resume) throw error; fail(); return; }
        if (epoch !== this.epoch || this.child !== child) return;
        this.transport.startMusic(pcm, this.selectedVolume ?? this.settings().musicVolume);
        this.decoderAttached = true;
        this.healthy();
      }
      this.transport.pauseMusic(this.paused);
      this.transport.musicPresence(this.title, this.artist, this.service, this.paused || !this.sourcePlaying);
      this.radio.observe({ key: `${this.session}:${track.service}:${track.queue_index}:${track.track_id || this.artist + ':' + this.title}`, title: this.title, artist: this.artist, playing: this.decoderAttached && !this.paused && this.sourcePlaying && !this.recovering,
        next: track.next_track && typeof track.next_track.title === "string" ? {title: track.next_track.title.slice(0,300), artist: typeof track.next_track.artist === "string" ? track.next_track.artist.slice(0,300) : ""} : undefined,
        position: this.spotifyStream ? Number(track.position_seconds) || 0 : this.position(), duration: this.spotifyStream ? Number(track.duration_seconds) || 0 : this.expectedDuration });
    } finally { this.polling = false; finished(); }
  }
}

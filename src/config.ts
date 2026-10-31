import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { runWindows } from "./process";
import { networkErrorCode, networkErrorMessage } from "./network-error";
import { dataDir } from "./platform";
export { dataDir } from "./platform";

export interface Settings {
  botToken: string; guildId: string; channelId: string;
  textEnabled: boolean; textChannelId: string; textMusicEnabled: boolean; textChatEnabled: boolean; textSummonEnabled: boolean;
  textChatMode: "context" | "all"; textContextSeconds: number; textMusicService: "yandex" | "vk" | "spotify";
  publicVoiceLeaveEnabled: boolean; publicVoiceAutoLeaveEnabled: boolean; publicVoiceEmptySeconds: number;
  allowedUserIds: string[]; commandsEnabled: boolean; confirmCommands: boolean;
  commandPhrase: string; wakeWord: string; addressMode: "all" | "name";
  bargeIn: boolean; silenceMs: number; maxUtteranceSecs: number;
  llmBaseUrl: string; llmApiKey: string; llmModel: string; llmUseAstra: boolean; llmProviderId: string; llmProviderKeys: Record<string, string>; llmKeyOrigin: string;
  llmUseAstraPersonality: boolean; llmPersonalityOrigin: string;
  screenDisplay: string; screenVisionConfirmed: boolean; screenCloudConfirmed: boolean; screenCloudOrigin: string; screenUserIds: string[];
  sttEngine: "api" | "vosk" | "whisper" | "google"; sttBaseUrl: string; sttApiKey: string; sttModel: string;
  googleSpeechConfirmed: boolean; googleApiKey: string;
  whisperModelPath: string; whisperPython: string; sttUseAstra: boolean;
  sttPython: string; voskModelPath: string; language: string;
  ttsEngine: "windows" | "api" | "fish" | "supertonic"; windowsVoice: string; windowsRate: number;
  ttsPython: string; supertonicModelPath: string; supertonicVoice: string; supertonicSpeed: number; supertonicCustomVoicePath: string;
  ttsBaseUrl: string; ttsApiKey: string; ttsModel: string; ttsVoice: string;
  fishApiKey: string; fishModel: string; fishVoice: string;
  musicVolume: number; musicFFmpeg: string;
  radioEnabled: boolean; radioEvery: number; radioWhen: "start" | "end"; radioNext: boolean; radioScheduleEnabled: boolean; radioSkipEmpty: boolean;
  radioScheduleTakeover: boolean; radioScheduleAnnounce: boolean;
  moderationEnabled: boolean; confirmModeration: boolean; moderatorUserIds: string[];
  moderationUserAliases: string; moderationChannelAliases: string;
}
export const defaults: Settings = {
  botToken: "", guildId: "", channelId: "", allowedUserIds: [], commandsEnabled: false,
  textEnabled: false, textChannelId: "", textMusicEnabled: false, textChatEnabled: false, textSummonEnabled: false,
  textChatMode: "context", textContextSeconds: 180, textMusicService: "yandex",
  publicVoiceLeaveEnabled: true, publicVoiceAutoLeaveEnabled: true, publicVoiceEmptySeconds: 120,
  confirmCommands: true, commandPhrase: "Астра выполни", wakeWord: "Астра", addressMode: "all",
  bargeIn: true, silenceMs: 800, maxUtteranceSecs: 20,
  llmBaseUrl: "http://127.0.0.1:1234/v1", llmApiKey: "", llmModel: "", llmUseAstra: false, llmProviderId: "manual", llmProviderKeys: {}, llmKeyOrigin: "",
  llmUseAstraPersonality: true, llmPersonalityOrigin: "https://api.hubris.pw",
  screenDisplay: "primary", screenVisionConfirmed: false, screenCloudConfirmed: false, screenCloudOrigin: "", screenUserIds: [],
  sttEngine: "api", sttBaseUrl: "https://api.openai.com/v1", sttApiKey: "", sttModel: "whisper-1",
  sttPython: "python", voskModelPath: "", language: "ru",
  whisperModelPath: "", whisperPython: "python", sttUseAstra: false,
  googleSpeechConfirmed: false, googleApiKey: "",
  ttsEngine: "windows", windowsVoice: "", windowsRate: 0,
  ttsPython: "python", supertonicModelPath: "", supertonicVoice: "F4", supertonicSpeed: 1.1, supertonicCustomVoicePath: "",
  ttsBaseUrl: "https://api.openai.com/v1", ttsApiKey: "", ttsModel: "tts-1", ttsVoice: "alloy",
  fishApiKey: "", fishModel: "s2.1-pro-free", fishVoice: "",
  musicVolume: 50, musicFFmpeg: "",
  radioEnabled: false, radioEvery: 3, radioWhen: "end", radioNext: true, radioScheduleEnabled: false, radioSkipEmpty: true,
  radioScheduleTakeover: true, radioScheduleAnnounce: true,
  moderationEnabled: false, confirmModeration: true, moderatorUserIds: [], moderationUserAliases: "", moderationChannelAliases: "",
};
const secrets = ["botToken", "llmApiKey", "sttApiKey", "ttsApiKey", "fishApiKey", "googleApiKey"] as const;
export const fishModels = ["s2.1-pro-free", "s2.1-pro", "s2-pro", "s1", "drama-3-preview"] as const;
export function ids(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : [];
  return [...new Set(list.map(String).map(x => x.trim()).filter(Boolean))];
}
export function normalizeSettings(value: unknown, base: Settings = defaults): Settings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = { ...base, allowedUserIds: [...base.allowedUserIds], moderatorUserIds: [...base.moderatorUserIds], screenUserIds: [...base.screenUserIds], llmProviderKeys: { ...base.llmProviderKeys } };
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    if (!(key in raw)) continue;
    if (key === "allowedUserIds") { result.allowedUserIds = ids(raw[key]); continue; }
    if (key === "moderatorUserIds") { result.moderatorUserIds = ids(raw[key]); continue; }
    if (key === "screenUserIds") { result.screenUserIds = ids(raw[key]); continue; }
    if (key === "llmProviderKeys") {
      const entries = raw[key];
      if (entries && typeof entries === "object" && !Array.isArray(entries)) result.llmProviderKeys = Object.fromEntries(Object.entries(entries).slice(0, 100).filter(([scope, key]) => scope.length <= 2048 && typeof key === "string" && key.length <= 8192));
      continue;
    }
    if (typeof defaults[key] === "boolean") (result as any)[key] = raw[key] === true;
    else if (typeof defaults[key] === "number") {
      const n = Number(raw[key]); if (Number.isFinite(n)) (result as any)[key] = n;
    } else if (typeof raw[key] === "string") (result as any)[key] = (raw[key] as string).trim().slice(0, 8192);
  }
  result.sttEngine = ["vosk", "whisper", "google"].includes(result.sttEngine) ? result.sttEngine : "api";
  result.ttsEngine = ["api", "fish", "supertonic"].includes(result.ttsEngine) ? result.ttsEngine : "windows";
  try {
    if (!result.screenCloudConfirmed || result.screenCloudOrigin !== new URL(result.llmBaseUrl).origin) { result.screenCloudConfirmed = false; result.screenCloudOrigin = ""; }
  } catch { result.screenCloudConfirmed = false; result.screenCloudOrigin = ""; }
  result.addressMode = result.addressMode === "name" ? "name" : "all";
  result.textChatMode = result.textChatMode === "all" ? "all" : "context";
  result.textMusicService = ["vk", "spotify"].includes(result.textMusicService) ? result.textMusicService : "yandex";
  result.textContextSeconds = Math.max(30, Math.min(900, Math.round(result.textContextSeconds)));
  result.publicVoiceEmptySeconds = Math.max(30, Math.min(1800, Math.round(result.publicVoiceEmptySeconds)));
  result.silenceMs = Math.max(350, Math.min(2000, result.silenceMs));
  result.maxUtteranceSecs = Math.max(5, Math.min(30, result.maxUtteranceSecs));
  result.windowsRate = Math.max(-5, Math.min(5, Math.round(result.windowsRate)));
  result.supertonicSpeed = Math.max(0.7, Math.min(2, result.supertonicSpeed));
  result.musicVolume = Math.max(0, Math.min(100, result.musicVolume));
  result.radioEvery = [1, 3, 5].includes(result.radioEvery) ? result.radioEvery : 3;
  result.radioWhen = result.radioWhen === "start" ? "start" : "end";
  return result;
}
export function validateSettings(s: Settings): void {
  if (s.sttEngine === "google" && !s.googleSpeechConfirmed) throw new Error("Подтвердите отправку речи участников в Google во вкладке «Голос и модель».");
  for (const id of [s.guildId, s.channelId, s.textChannelId, ...s.allowedUserIds, ...s.moderatorUserIds, ...s.screenUserIds].filter(Boolean)) {
    if (!/^\d{17,20}$/.test(id)) throw new Error("Discord ID должен содержать от 17 до 20 цифр. Укажите ID, а не ник.");
  }
  if (!s.commandPhrase || s.commandPhrase.length < 4) throw new Error("Укажите фразу для команд ПК, например «Астра выполни».");
  if (!s.screenDisplay || s.screenDisplay.length > 64) throw new Error("Выберите экран для передачи снимков.");
  if (s.commandsEnabled && !s.allowedUserIds.length) throw new Error("Добавьте хотя бы один разрешённый Discord ID для управления ПК.");
  if (s.moderationEnabled && !s.moderatorUserIds.length) throw new Error("Добавьте хотя бы один Discord ID во вкладке «Участники» для модерации.");
  for (const aliases of [s.moderationUserAliases, s.moderationChannelAliases]) {
    const lines = aliases.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length > 100 || lines.some(line => !/^\d{17,20}\s*=\s*[^=]+$/u.test(line) || line.length > 300)) throw new Error("Голосовые имена: одна строка «Discord ID = имя, другое имя», до 100 строк и 300 символов в строке.");
  }
  if (s.ttsEngine === "supertonic" && !/^(?:[MF][1-5]|custom)$/.test(s.supertonicVoice)) throw new Error("Выберите голос Supertonic F1–F5, M1–M5 или свой JSON.");
  if (s.ttsEngine === "supertonic" && s.supertonicVoice === "custom" && !s.supertonicCustomVoicePath) throw new Error("Загрузите JSON собственного голоса.");
  if (s.ttsEngine === "fish" && !(fishModels as readonly string[]).includes(s.fishModel)) throw new Error("Выберите поддерживаемую модель Fish Audio из списка. Неизвестное имя может переключить сервис на платную модель.");
  if (/[\r\n\0]/.test(s.fishApiKey)) throw new Error("Ключ Fish Audio должен быть одной строкой.");
  for (const url of [s.llmBaseUrl, s.sttBaseUrl, s.ttsBaseUrl]) apiUrl(url, "");
}
/** Draft settings may be saved before discovery has supplied all channel IDs. */
export function textSetupIssue(s: Settings): string {
  const missing: string[] = [];
  if (!s.botToken) missing.push("токен бота");
  if (!s.guildId) missing.push("ID сервера");
  if (!s.textChannelId) missing.push("ID текстового канала");
  return missing.length ? "Текстовый канал пока не подключён. Укажите: " + missing.join(", ") + ". Затем сохраните настройки." : "";
}
export function apiUrl(base: string, suffix: string): string {
  let parsed: URL;
  try { parsed = new URL(base); } catch { throw new Error("Адрес API должен начинаться с http:// или https://."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Укажите базовый адрес API без логина, пароля и параметров.");
  const host = parsed.hostname;
  if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(host) && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) throw new Error("Для внешнего API используйте HTTPS; HTTP разрешён в локальной сети.");
  return base.replace(/\/+$/, "") + suffix;
}
export function publicSettings(s: Settings): Record<string, unknown> {
  const result: Record<string, unknown> = { ...s };
  delete result.llmProviderKeys;
  result.llmKeyScope = llmKeyScope(s);
  result.llmSavedConnections = Object.keys(s.llmProviderKeys);
  for (const key of secrets) { result[key] = ""; result[`${key}Saved`] = !!s[key]; }
  return result;
}
export function llmKeyScope(s: Pick<Settings, "llmProviderId" | "llmBaseUrl">): string {
  return JSON.stringify([s.llmProviderId, new URL(apiUrl(s.llmBaseUrl, "")).href.replace(/\/+$/, "")]);
}
export function usableModelKey(key: string): boolean {
  const buffer = Buffer.from(key, "base64");
  try { return !!key && !buffer.subarray(0, 20).equals(Buffer.from("01000000d08c9ddf0115d1118c7a00c04fc297eb", "hex")); }
  finally { buffer.fill(0); }
}
export function modelKey(s: Settings, target: Pick<Settings, "llmProviderId" | "llmBaseUrl"> = s): string {
  const key = s.llmProviderKeys[llmKeyScope(target)];
  if (key && usableModelKey(key)) return key;
  // Migration from the single-key version is restricted to the same API path.
  if (s.llmProviderId === "manual" && new URL(apiUrl(s.llmBaseUrl, "")).href === new URL(apiUrl(target.llmBaseUrl, "")).href && s.llmKeyOrigin === new URL(target.llmBaseUrl).origin && usableModelKey(s.llmApiKey)) return s.llmApiKey;
  return "";
}
export class SettingsStore {
  private loaded?: Settings;
  async load(): Promise<Settings> {
    if (this.loaded) return this.loaded;
    let raw: any;
    try { raw = JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8")); }
    catch (e: any) { if (e.code === "ENOENT") return this.loaded = normalizeSettings({}); throw new Error("Не удалось прочитать настройки плагина. Существующий файл сохранён."); }
    let plain: any = {};
    if (raw.protectedSecrets) {
      const decrypted = await runWindows({ action: "unprotect", value: raw.protectedSecrets });
      try { plain = JSON.parse(decrypted.toString("utf8")); }
      catch { throw new Error("Сохранённые ключи расшифрованы, но их формат повреждён. Файл настроек сохранён."); }
      finally { decrypted.fill(0); }
    }
    const loaded = normalizeSettings({ ...raw.settings, ...plain });
    // Older profiles had no separate screen list: keep showing the screen to
    // everyone who already had PC access. An explicit (even empty) list wins.
    const savedSettings = raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings) ? raw.settings as Record<string, unknown> : {};
    if (!("screenUserIds" in savedSettings)) loaded.screenUserIds = [...loaded.allowedUserIds];
    // Move only our own runtime paths after the user-requested project rename.
    // User models, the stable data folder, and encrypted keys stay in place.
    const oldRoot = "D:\\IT\\Astra\\discord-voice-bridge";
    const root = resolve(__dirname, "..");
    for (const field of ["ttsPython", "whisperPython", "sttPython", "voskModelPath", "whisperModelPath", "supertonicModelPath", "musicFFmpeg"] as const) {
      const previous = loaded[field];
      if (!previous.toLowerCase().startsWith((oldRoot + "\\").toLowerCase())) continue;
      const suffix = relative(oldRoot, previous), candidate = resolve(root, suffix);
      if (isAbsolute(suffix) || suffix.startsWith("..") || !candidate.toLowerCase().startsWith((root + "\\").toLowerCase())) continue;
      try { await access(candidate); loaded[field] = candidate; } catch {}
    }
    if (usableModelKey(loaded.llmApiKey) && loaded.llmKeyOrigin === new URL(loaded.llmBaseUrl).origin && !loaded.llmProviderKeys[llmKeyScope(loaded)]) loaded.llmProviderKeys[llmKeyScope(loaded)] = loaded.llmApiKey;
    loaded.llmApiKey = modelKey(loaded);
    return this.loaded = loaded;
  }
  async save(value: unknown): Promise<Settings> {
    const current = await this.load();
    const input = value && typeof value === "object" ? { ...value as Record<string, unknown> } : {};
    for (const key of secrets) {
      if (input[key] === "" || input[key] === undefined) delete input[key];
      if (input[`clear_${key}`] === true) input[key] = "";
    }
    const next = normalizeSettings(input, current);
    validateSettings(next);
    next.llmProviderKeys = { ...current.llmProviderKeys };
    const scope = llmKeyScope(next);
    const inherited = modelKey(current, next);
    if (inherited && !next.llmProviderKeys[scope]) next.llmProviderKeys[scope] = inherited;
    if (typeof input.llmApiKey === "string" && input.llmApiKey.trim()) {
      if (input.llmApiKey.length > 8192 || /[\r\n\0]/.test(input.llmApiKey)) throw new Error("Ключ API должен быть одной строкой допустимого размера.");
      if (!usableModelKey(input.llmApiKey.trim())) throw new Error("Введите действительный API-ключ, а не зашифрованную строку из Astra.");
      next.llmProviderKeys[scope] = input.llmApiKey.trim();
    }
    if (input.clear_llmApiKey === true) delete next.llmProviderKeys[scope];
    next.llmApiKey = next.llmProviderKeys[scope] || "";
    next.llmKeyOrigin = new URL(next.llmBaseUrl).origin;
    const plain: Record<string, unknown> = { llmProviderKeys: next.llmProviderKeys };
    const visible: any = { ...next };
    delete visible.llmProviderKeys;
    for (const key of secrets) { plain[key] = next[key]; delete visible[key]; }
    const protectedSecrets = (await runWindows({ action: "protect", value: JSON.stringify(plain) })).toString("utf8");
    await mkdir(dataDir, { recursive: true });
    const temp = join(dataDir, "settings.json.tmp");
    await writeFile(temp, JSON.stringify({ version: 1, settings: visible, protectedSecrets }, null, 2), { mode: 0o600 });
    await rename(temp, join(dataDir, "settings.json"));
    return this.loaded = next;
  }
}
export function safeError(error: unknown, s?: Settings): string {
  let message = error instanceof Error ? error.message : "Не удалось выполнить запрос.";
  const network = networkErrorCode(error);
  if (network && !/[а-яё]/iu.test(message)) message = networkErrorMessage(network);
  for (const key of secrets) if (s?.[key]) message = message.split(s[key]).join("[скрыто]");
  for (const key of Object.values(s?.llmProviderKeys || {})) if (key) message = message.split(key).join("[скрыто]");
  return message.replace(/Bearer\s+\S+/gi, "Bearer [скрыто]").slice(0, 320);
}

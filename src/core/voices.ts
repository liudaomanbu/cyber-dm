import { z } from 'zod';

const voiceTags = z.object({
  languages: z.array(z.string()).optional(),
  age: z.string().optional(),
  gender: z.string().optional(),
  styles: z.array(z.string()).optional(),
  scenes: z.array(z.string()).optional(),
}).passthrough();

/**
 * The catalog's id identifies a voice resource. `voice_type` is a separate
 * value sent to the Linx TTS callback; never infer one from the other.
 * A few catalog versions spell the id/name fields differently, so normalize
 * those aliases while retaining all original fields through passthrough().
 */
export const voiceSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const tags = source.tags && typeof source.tags === 'object' && !Array.isArray(source.tags)
    ? { ...(source.tags as Record<string, unknown>) }
    : {};
  // The Linx catalog uses null for missing tag dimensions on some voices.
  // Remove those fields before validation so a partial catalog entry remains
  // usable while the scoring code continues to treat them as absent.
  for (const key of ['languages', 'age', 'gender', 'styles', 'scenes']) {
    if (tags[key] == null) delete tags[key];
  }
  const language = source.language;
  if (!tags.languages && typeof language === 'string' && language) tags.languages = [language];
  return {
    ...source,
    id: source.id ?? source.voice_id ?? source.voiceId,
    name: source.name ?? source.display_name ?? source.voice_name ?? source.voice_id ?? source.voiceId,
    demo: source.demo ?? source.demo_url ?? source.preview_url,
    tags: Object.keys(tags).length ? tags : undefined,
    provider: source.provider ?? source.tts_provider,
    // Deliberately do not use id/voice_id as a voice_type fallback.
    voice_type: source.voice_type ?? source.voiceType,
  };
}, z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  demo: z.string().optional(),
  tags: voiceTags.optional(),
  provider: z.string().optional(),
  voice_type: z.string().optional(),
}).passthrough());

export type Voice = z.infer<typeof voiceSchema>;
export type VoiceRole = { id: string; name: string; voiceHint?: string };

const styles: Record<string, string[]> = {
  chenwen: ['沉稳', '稳重'],
  wenrou: ['温柔', '温和'],
  kailang: ['明亮', '开朗'],
  zhishuai: ['利落', '直率'],
  lengjing: ['克制', '冷静'],
  zhixing: ['清晰', '知性'],
};

function chineseVoice(voice: Voice): boolean {
  const languages = voice.tags?.languages;
  if (!languages?.length) return true;
  return languages.some((language) => /^(zh|cmn|中文|普通话)/i.test(language));
}

function usableVoice(voice: Voice): boolean {
  // Clone voices are only usable after asynchronous training succeeds. Native
  // catalog entries generally have no state, so they remain eligible.
  const state = (voice as Voice & { state?: unknown }).state;
  return typeof state !== 'string' || !['Init', 'Training', 'Failed'].includes(state);
}

function genderMatch(value: string | undefined, expected: 'female' | 'male'): boolean {
  const normalized = value?.toLowerCase() ?? '';
  return expected === 'female'
    ? /female|woman|女/.test(normalized)
    : /male|man|男/.test(normalized);
}

function ageMatch(value: string | undefined): boolean {
  return /adult|middle|young|成年|青年|中年|年轻/i.test(value ?? '');
}

export function chooseVoices(roles: VoiceRole[], voices: Voice[]): Record<string, Voice> {
  // De-duplicate before counting: otherwise duplicate catalog rows can make
  // the availability check pass and leave a role without a voice later.
  const available = [...new Map(voices.filter((voice) => chineseVoice(voice) && usableVoice(voice)).map((voice) => [voice.id, voice])).values()];
  if (available.length < roles.length) {
    throw new Error(`需要 ${roles.length} 个不同中文音色，目前只有 ${available.length} 个；请补充音色后重试`);
  }

  const used = new Set<string>();
  const selected: Record<string, Voice> = {};
  for (const role of roles) {
    const hint = role.voiceHint ?? '';
    const score = (voice: Voice) => {
      let score = 0;
      const tags = voice.tags;
      if (hint.includes('女')) score += genderMatch(tags?.gender, 'female') ? 20 : -20;
      if (hint.includes('男')) score += genderMatch(tags?.gender, 'male') ? 20 : -20;
      if (hint.includes('成年')) score += ageMatch(tags?.age) ? 3 : 0;
      for (const [style, words] of Object.entries(styles)) {
        if (words.some((word) => hint.includes(word)) && tags?.styles?.some((item) => item === style || words.includes(item))) score += 5;
      }
      if (role.id === 'dm' && tags?.scenes?.some((scene) => /audiobook|有声书/i.test(scene))) score += 10;
      // Prefer a catalog-provided voice_type/provider because this lets the
      // default assignment be immediately usable by the Linx callback.
      if (voice.voice_type) score += 1;
      if (voice.provider) score += 1;
      return score;
    };
    const choice = available
      .filter((voice) => !used.has(voice.id))
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
    // The availability check above makes this unreachable, but keeping the
    // guard makes malformed role lists fail with a useful error.
    if (!choice) throw new Error(`无法为角色 ${role.name} 分配独立中文音色`);
    selected[role.id] = choice;
    used.add(choice.id);
  }
  return selected;
}

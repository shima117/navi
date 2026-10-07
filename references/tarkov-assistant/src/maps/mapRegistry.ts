import customsImage from '../assets/maps/customs.png';
import factoryImage from '../assets/maps/factory.png';
import groundZeroImage from '../assets/maps/ground-zero.png';
import icebreakerImage from '../assets/maps/icebreaker.png';
import interchangeImage from '../assets/maps/interchange.png';
import lighthouseImage from '../assets/maps/lighthouse.png';
import reserveImage from '../assets/maps/reserve.png';
import shorelineImage from '../assets/maps/shoreline.png';
import streetsImage from '../assets/maps/streets-of-tarkov.png';
import terminalImage from '../assets/maps/terminal.png';
import theLabImage from '../assets/maps/the-lab.png';
import theLabyrinthImage from '../assets/maps/the-labyrinth.png';
import woodsImage from '../assets/maps/woods.png';
import type { MapRef } from '../types';

export interface BuiltInMap {
  /** アプリ内の正規キー。tarkov.dev の normalizedName に合わせてある。 */
  key: string;
  /** tarkov.dev から名前を取得できないときのフォールバック表示名。 */
  displayName: string;
  /** Vite が解決する同梱画像のURL。 */
  image: string;
  /**
   * キャリブレーションを画像単位で識別するID。
   * 同梱画像を差し替えたときは必ず末尾のリビジョンを上げること。
   * 上げないと古い画像用の較正点が新しい画像へ誤適用される。
   */
  imageId: string;
  /** tarkov.dev の map id / normalizedName / 表示名。表示名の完全一致には依存しない。 */
  aliases: string[];
  /** 画像内に埋め込まれた出典表記。トリミング・削除は禁止。 */
  attribution?: string;
  /** 画像内に明記されているライセンス。 */
  license?: string;
}

/**
 * 同梱している標準MAP画像。
 *
 * tarkov.dev は Factory / Night Factory、Ground Zero / Ground Zero 21+ / チュートリアル、
 * The Lab / The Lab (Dark) を別MAPとして返すため、同じ地形を指すIDを aliases でまとめている。
 */
export const BUILT_IN_MAPS: readonly BuiltInMap[] = [
  {
    key: 'customs',
    displayName: 'Customs',
    image: customsImage,
    imageId: 'builtin:customs:1',
    aliases: ['56f40101d2720b2a4d8b45d6', 'customs'],
  },
  {
    key: 'ground-zero',
    displayName: 'Ground Zero',
    image: groundZeroImage,
    imageId: 'builtin:ground-zero:1',
    aliases: [
      '653e6760052c01c1c805532f',
      '65b8d6f5cdde2479cb2a3125',
      '68236e8153654e8c1200798a',
      'ground-zero',
      'ground-zero-21',
      'ground-zero-tutorial',
      'sandbox',
      'sandbox-high',
    ],
  },
  {
    key: 'factory',
    displayName: 'Factory',
    image: factoryImage,
    imageId: 'builtin:factory:1',
    aliases: ['55f2d3fd4bdc2d5f408b4567', '59fc81d786f774390775787e', 'factory', 'night-factory'],
  },
  {
    key: 'interchange',
    displayName: 'Interchange',
    image: interchangeImage,
    imageId: 'builtin:interchange:1',
    aliases: ['5714dbc024597771384a510d', 'interchange'],
  },
  {
    key: 'woods',
    displayName: 'Woods',
    image: woodsImage,
    imageId: 'builtin:woods:1',
    aliases: ['5704e3c2d2720bac5b8b4567', 'woods'],
  },
  {
    key: 'shoreline',
    displayName: 'Shoreline',
    image: shorelineImage,
    imageId: 'builtin:shoreline:1',
    aliases: ['5704e554d2720bac5b8b456e', 'shoreline'],
  },
  {
    key: 'reserve',
    displayName: 'Reserve',
    image: reserveImage,
    imageId: 'builtin:reserve:1',
    aliases: ['5704e5fad2720bc05b8b4567', 'reserve', 'rezervbase'],
  },
  {
    key: 'lighthouse',
    displayName: 'Lighthouse',
    image: lighthouseImage,
    imageId: 'builtin:lighthouse:1',
    aliases: ['5704e4dad2720bb55b8b4567', 'lighthouse'],
  },
  {
    key: 'streets-of-tarkov',
    displayName: 'Streets of Tarkov',
    image: streetsImage,
    imageId: 'builtin:streets-of-tarkov:1',
    aliases: ['5714dc692459777137212e12', 'streets-of-tarkov', 'streets', 'tarkovstreets'],
  },
  {
    key: 'the-lab',
    displayName: 'The Lab',
    image: theLabImage,
    imageId: 'builtin:the-lab:1',
    aliases: ['5b0fc42d86f7744a585f9105', '6a294a5b5eb5f9a1700417b7', 'the-lab', 'the-lab-dark', 'laboratory'],
  },
  {
    key: 'the-labyrinth',
    displayName: 'The Labyrinth',
    image: theLabyrinthImage,
    imageId: 'builtin:the-labyrinth:1',
    aliases: ['6733700029c367a3d40b02af', 'the-labyrinth', 'labyrinth'],
  },
  {
    key: 'icebreaker',
    displayName: 'Icebreaker',
    image: icebreakerImage,
    imageId: 'builtin:icebreaker:1',
    aliases: ['69af492a4819ea4ba10a69c5', 'icebreaker'],
  },
  {
    key: 'terminal',
    displayName: 'Terminal',
    image: terminalImage,
    imageId: 'builtin:terminal:1',
    aliases: ['65cc8f81a9aac3e77d0cfd3e', 'terminal'],
    attribution: 'MAP BY RE3MR.COM (MAP VERSION 1.2)',
    license: 'CC BY-NC-SA 4.0',
  },
];

const slug = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const ALIAS_INDEX = (() => {
  const index = new Map<string, BuiltInMap>();
  for (const entry of BUILT_IN_MAPS) {
    for (const alias of [entry.key, entry.displayName, ...entry.aliases]) {
      const raw = String(alias).trim().toLowerCase();
      if (raw) index.set(raw, entry);
      const slugged = slug(alias);
      if (slugged) index.set(slugged, entry);
    }
  }
  return index;
})();

export type MapLike = Partial<Pick<MapRef, 'id' | 'name' | 'normalizedName'>> | string | null | undefined;

/**
 * tarkov.dev の MAP 参照（id / normalizedName / 表示名のいずれか）から同梱画像を引く。
 * 表示名の完全一致だけには依存せず、ID → normalizedName → 名前のスラッグ の順に照合する。
 */
export function resolveBuiltInMap(map: MapLike): BuiltInMap | null {
  if (!map) return null;
  const candidates = typeof map === 'string'
    ? [map]
    : [map.id, map.normalizedName, map.name];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const direct = ALIAS_INDEX.get(String(candidate).trim().toLowerCase());
    if (direct) return direct;
    const slugged = ALIAS_INDEX.get(slug(candidate));
    if (slugged) return slugged;
  }
  return null;
}

export function builtInMapKeys(): string[] {
  return BUILT_IN_MAPS.map((entry) => entry.key);
}

export function hasBuiltInMap(map: MapLike): boolean {
  return resolveBuiltInMap(map) !== null;
}

/** 画像内に出典表記がある同梱MAP。UIで必ず併記する。 */
export function builtInMapAttributions(): BuiltInMap[] {
  return BUILT_IN_MAPS.filter((entry) => entry.attribution);
}

export interface ResolvedMapImage {
  src: string;
  /** 較正点をひもづける画像識別子。 */
  imageId: string;
  source: 'user' | 'builtin';
  attribution?: string;
  license?: string;
}

export interface UserMapImage {
  src: string;
  imageId: string;
}

/**
 * 表示に使うMAP画像を決める。
 * 優先順位は「ユーザーが設定したカスタムMAP」→「同梱の標準MAP」。
 */
export function resolveMapImage(map: MapLike, userImage?: UserMapImage | null): ResolvedMapImage | null {
  if (userImage?.src && userImage.imageId) {
    return { src: userImage.src, imageId: userImage.imageId, source: 'user' };
  }
  const builtIn = resolveBuiltInMap(map);
  if (!builtIn) return null;
  return {
    src: builtIn.image,
    imageId: builtIn.imageId,
    source: 'builtin',
    attribution: builtIn.attribution,
    license: builtIn.license,
  };
}

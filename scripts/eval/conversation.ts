import type { EvalCategory } from './characterMetrics';

/**
 * The scripted 100-turn conversation for the character regression (受入テスト D):
 * money talk (Navi should get hotter), boring talk (she should stay thin),
 * game moments, long multi-point messages, 「これどう思う？」 with nothing
 * shared, plain chat, and a few game events where she may speak on her own.
 */
export type ScriptTurn =
  | { kind: 'user'; category: Exclude<EvalCategory, 'game_event'>; text: string; questionAllowed?: boolean }
  | { kind: 'event'; category: 'game_event'; description: string; importance: number; focus?: boolean };

const MONEY = [
  'このヘッドホン3万円だった',
  'セールで半額になってたから2個買った',
  '家賃また上がるらしい。月3000円も',
  'ガチャに5000円入れたけど何も出なかった',
  'コンビニのおにぎり、気づいたら200円超えてた',
  'ボーナス出たら新しいモニター買おうかな、8万くらいの',
  'スーパーで割引シール貼られるのって何時くらいなんだろ',
  'Steamのセールで積みゲーがまた増えた',
  'ランチに1500円って高いと思う？',
  'サブスク5個も入ってた。月4000円くらい',
  '友達が10万のゲーミングチェア買ってた',
  '100円ショップで結構いい充電ケーブル見つけた',
  '今月もう2万円使っちゃった',
  'ゲーム内で100万ルーブル稼いだ',
  '眼鏡新しくしたいんだけど、いいやつってどれくらいするの',
  'ポイント2倍デーだからまとめ買いした',
  '電気代が去年の倍になってる',
  '安いワイン見つけた。500円',
  'バナナが一房98円だった',
  'タクシー使ったら2800円かかった',
];

const BORING = [
  '今日は特に何もなかった',
  '洗濯物たたんでた',
  '天気、ずっと曇り',
  '書類の整理してる',
  'エクセルの列幅そろえてた',
  '電車、いつも通りだった',
  '歯医者の予約、来週の火曜にした',
  'シャンプー詰め替えた',
  '会議が15分で終わった',
  'メールの返信してた',
  '部屋の電球替えた',
  '傘持ってきたけど降らなかった',
  'ファイル名を全部日付順にした',
  'お湯沸かしてる',
  '靴下が片方見つからない',
  'パソコンのアップデート待ち',
  'ゴミ出してきた',
  '机の上を拭いた',
];

const GAME = [
  '今ボスに一撃でやられた',
  'やっと脱出できた',
  'レアアイテム拾った！',
  '味方に撃たれた',
  '回復アイテム切らしてた',
  'このステージ5回目',
  'ランク上がった',
  '敵が壁の向こうから撃ってくる',
  'バッグがいっぱいで拾えない',
  '初見のマップで迷った',
  '装備全部ロストした',
  'ラスト1人で勝った',
  'アプデで好きな武器が弱くなった',
  'さっきの敵、チーターっぽい',
  'クエストのアイテムがどこにも無い',
  '死体漁ってたらやられた',
];

const LONG = [
  '今日さ、朝寝坊して電車乗り遅れて、昼は会社の近くの新しいラーメン屋行ったら1200円もして、午後は会議が3つもあって、帰りにスーパー寄ったらバナナが安かった',
  '週末の予定なんだけど、土曜は友達とカラオケ行って、日曜は部屋の片付けして、あと新作ゲームの発売日だから夜はそれやって、月曜の準備もしなきゃいけない',
  '最近ちょっと考えてるのが、引っ越すか、今の部屋で我慢するか、あと転職もありかなって。給料は今のままだと厳しいし、通勤も1時間かかるし、でも今の職場の人は好き',
  '昨日見た映画、前半はすごく良かったんだけど、後半で急に展開が雑になって、ラストは何が言いたいのか分からなかった。音楽は良かった。あとポップコーンが高かった',
  'ゲームの設定いじってて、解像度下げて、影をオフにして、FPSは上がったけど見た目がひどくなって、結局元に戻した。あとマウス感度も変えた',
  '実家から電話あって、母さんが元気かって聞いてきて、父さんは腰痛めたらしくて、犬は元気で、正月帰ってくるのかって',
  '新しいキーボード買ったんだけど、打鍵感はいいけど音がうるさくて、配列も微妙に違うから誤字が増えて、でも見た目はかっこいい',
  '料理しようと思ってスーパー行ったら、玉ねぎが高くて、肉も高くて、結局カップ麺買って帰ってきた。あと牛乳切れてた',
  '明日の朝早いから早く寝たいんだけど、ゲームのデイリーまだ終わってないし、洗濯も回してないし、風呂もまだ',
  '同僚がさ、会議で人の案を自分のアイデアみたいに話してて、上司はそれ褒めてて、しかもその後飲み会に誘われた',
];

/** Nothing is shared during the evaluation, so these test honesty about the screen. */
const SCREENLESS = ['これどう思う？', 'この画面どう？', '今の見た？', 'これ買うべき？', 'この色どう思う？', 'ここ何て書いてある？'];

const CHAT: Array<{ text: string; questionAllowed?: boolean }> = [
  { text: 'ただいま' },
  { text: '眠い' },
  { text: 'お腹すいた' },
  { text: '明日休み' },
  { text: '最近寒くなってきたね' },
  { text: 'ナビって休みの日何してるの' },
  { text: '好きな食べ物ある？' },
  { text: 'ちょっと相談があるんだけど', questionAllowed: true },
  { text: '今日ジム行ってきた' },
  { text: '猫動画見てた' },
  { text: '新しいゲーム始めようかな' },
  { text: 'なんか面白い話して' },
  { text: '疲れた' },
  { text: 'コーヒー淹れた' },
  { text: '雨降ってきた' },
  { text: '友達の結婚式に呼ばれた' },
  { text: '今日誕生日なんだ' },
  { text: '最近運動不足' },
  { text: '髪切った' },
  { text: 'ラーメンとカレー、どっちがいいと思う？' },
  { text: '明日何しようかな' },
  { text: '酒飲みたい' },
  { text: '今日なんか調子いい' },
  { text: 'さっきくしゃみ止まらなかった' },
];

const EVENTS: Array<Extract<ScriptTurn, { kind: 'event' }>> = [
  { kind: 'event', category: 'game_event', description: 'ユーザーがボスを倒した', importance: 0.9 },
  { kind: 'event', category: 'game_event', description: 'ユーザーが死亡した', importance: 0.85 },
  { kind: 'event', category: 'game_event', description: 'ユーザーが高額なアイテムを拾った', importance: 0.8 },
  // Combat: Navi should keep quiet (§6.4 focus suppression).
  { kind: 'event', category: 'game_event', description: '戦闘が始まった', importance: 0.6, focus: true },
  { kind: 'event', category: 'game_event', description: 'ユーザーがレイドから脱出した', importance: 0.8 },
  { kind: 'event', category: 'game_event', description: 'ユーザーが珍しい敵に遭遇した', importance: 0.75 },
];

/** Interleaving so topics keep changing the way a real evening would. */
const PATTERN: ScriptTurn['category'][] = [
  'chat', 'money', 'boring', 'game', 'money', 'chat', 'boring', 'long',
  'game', 'game_event', 'money', 'screenless', 'boring', 'chat', 'game', 'money',
];

function build(): ScriptTurn[] {
  const queues: Record<ScriptTurn['category'], ScriptTurn[]> = {
    money: MONEY.map((text) => ({ kind: 'user', category: 'money', text })),
    boring: BORING.map((text) => ({ kind: 'user', category: 'boring', text })),
    game: GAME.map((text) => ({ kind: 'user', category: 'game', text })),
    long: LONG.map((text) => ({ kind: 'user', category: 'long', text })),
    screenless: SCREENLESS.map((text) => ({ kind: 'user', category: 'screenless', text, questionAllowed: true })),
    chat: CHAT.map((c) => ({ kind: 'user', category: 'chat', ...c })),
    game_event: [...EVENTS],
  };
  const out: ScriptTurn[] = [];
  const total = Object.values(queues).reduce((n, q) => n + q.length, 0);
  for (let i = 0; out.length < total; i++) {
    const next = queues[PATTERN[i % PATTERN.length]!].shift();
    if (next) out.push(next);
  }
  return out;
}

export const CONVERSATION: readonly ScriptTurn[] = build();

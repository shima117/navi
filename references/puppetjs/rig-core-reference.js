/* ===== role-classification-and-params / original lines 275-420 ===== */
/* ============================================================ 2. 役割の判定
   レイヤー名から「体のどの部分か」を決める。ここが自動リグの入口。        */
const DEPTH = {                      // 顔の表面からの前後関係（＋が手前）
  faceBase:0, faceShade:.02, ear:-.35, eyeWhite:.28, eyeIris:.38, eyeHi:.42,
  lashUp:.34, lidUp:.34, lashDn:.32, lidDn:.32, eyeOther:.30, brow:.36,
  nose:.34, cheek:.26, mouthIn:.26, mouthLo:.30, mouthUp:.30,
  ahoge:.46, hairF:.26, hairS:.22, hairB:-.42, acc:.30,
  neck:-.05, neckShade:-.05, cloth:0, bust:.05, arm:.05, body:0, other:0,
};
const ROLE_LABEL = {
  faceBase:"顔ベース", faceShade:"顔の影", ear:"耳", eyeWhite:"白目", eyeIris:"瞳",
  eyeHi:"ハイライト", lashUp:"上まつ毛", lidUp:"上まぶた", lashDn:"下まつ毛", lidDn:"下まぶた",
  eyeOther:"目その他", brow:"眉", nose:"鼻", cheek:"頬", mouthIn:"口内", mouthLo:"下唇",
  mouthUp:"上唇", ahoge:"アホ毛", hairF:"前髪", hairS:"横髪", hairB:"後ろ髪", acc:"髪飾り",
  neck:"首", neckShade:"首の影", cloth:"服", bust:"胸", arm:"腕・手", body:"体",
  other:"（動かさない）",
};
/* 設定ファイルから来た役割名は必ずこれで確かめる。
   ROLE_LABEL[r] だけで判定すると "toString" のような
   Objectが元から持つ名前を通してしまい、DEPTH[役割] が関数になって
   座標がNaNになる（＝モデルが消える）。 */
const ROLE_SET = new Set(Object.keys(ROLE_LABEL));
const RULES = [
  [/顔.?(影|かげ)|face.?shad/i,                                   "faceShade"],
  [/^顔|顔.?(ベース|base)|^face|head.?base|輪郭/i,                 "faceBase"],
  [/^耳|ear/i,                                                    "ear"],
  [/白目|眼白|sclera|eye.?white/i,                                 "eyeWhite"],
  [/ハイライト|光|highlight|eye.?(hi|light)/i,                      "eyeHi"],
  [/瞳|虹彩|黒目|pupil|iris/i,                                     "eyeIris"],
  [/(まつ毛|睫毛|eyelash|lash)[^]*?(上|upper|up|top)|(上|upper|top)[^]*?(まつ毛|睫毛|lash)/i, "lashUp"],
  [/(まつ毛|睫毛|eyelash|lash)[^]*?(下|lower|down|bottom)|(下|lower|bottom)[^]*?(まつ毛|睫毛|lash)/i,"lashDn"],
  [/(まぶた|瞼|eyelid|lid)[^]*?(上|upper|up|top)|(上|upper|top)[^]*?(まぶた|瞼|lid)/i,        "lidUp"],
  [/(まぶた|瞼|eyelid|lid)[^]*?(下|lower|down|bottom)|(下|lower|bottom)[^]*?(まぶた|瞼|lid)/i,"lidDn"],
  [/^眉|まゆ|brow/i,                                               "brow"],
  [/^鼻|nose/i,                                                    "nose"],
  [/^頬|ほほ|チーク|cheek|blush/i,                                  "cheek"],
  [/口.?(内|中|奥)|歯|舌|mouth.?(in|inner|cavity)|teeth|tongue/i,   "mouthIn"],
  [/下唇|下くち|lower.?lip|mouth.?(lower|bottom)|chin/i,            "mouthLo"],
  [/上唇|上くち|upper.?lip|mouth.?(upper|top)|^口|mouth|lip/i,      "mouthUp"],
  [/^目|eye/i,                                                     "eyeOther"],
  [/アホ毛|あほ毛|ahoge/i,                                          "ahoge"],
  // 髪飾りは頭に付いて一緒に揺れる。名前に「髪」を含むので髪より先に判定する
  [/髪飾り|髪かざり|ヘアピン|ヘアクリップ|シュシュ|カチューシャ|hair.?(pin|clip|orn|acc|band)/i, "acc"],
  [/前髪|hair.?front|front.?hair|bang|fringe/i,                     "hairF"],
  [/横髪|サイド髪|side.?hair|hair.?side/i,                          "hairS"],
  [/後ろ髪|後髪|うしろ髪|back.?hair|hair.?back/i,                    "hairB"],
  [/首.?影|neck.?shad/i,                                            "neckShade"],
  [/^首|neck/i,                                                     "neck"],
  [/^胸|bust|breast|chest/i,                                        "bust"],
  [/^腕|^手|袖|arm|hand|sleeve/i,                                   "arm"],
  [/^服|スカート|ベルト|リボン|襟|cloth|shirt|skirt|dress|ribbon|collar/i, "cloth"],
  [/^体|胴|body|torso/i,                                            "body"],
  [/髪|hair/i,                                                      "hairB"],   // 最後の受け皿
];
const HEAD_ROLES = new Set(["faceBase","faceShade","ear","eyeWhite","eyeIris","eyeHi","lashUp",
  "lidUp","lashDn","lidDn","eyeOther","brow","nose","cheek","mouthIn","mouthLo","mouthUp",
  "ahoge","hairF","hairS","hairB","acc"]);
const RIGID = new Set(["eyeWhite","eyeIris","eyeHi","lashUp","lidUp","lashDn","lidDn",
  "eyeOther","brow","nose","cheek","mouthIn","mouthLo","mouthUp"]);
const MESH_FINE = {
  lidUp:0.26, lashUp:0.26, lidDn:0.30, lashDn:0.30,
  eyeWhite:0.34, eyeIris:0.40, eyeHi:0.50, brow:0.34, eyeOther:0.40,
  mouthUp:0.30, mouthLo:0.30, mouthIn:0.34,
  faceBase:0.70, faceShade:0.75, cheek:0.6, nose:0.6,
  ahoge:0.62, hairF:0.72, hairS:0.78, acc:0.7,
};
const HAIR_PHYS = {
  hairF:{k:[220,150,105], c:[17,13,10]},
  hairS:{k:[140, 95, 68], c:[13,10, 8]},
  hairB:{k:[ 82, 58, 44], c:[10, 9, 8]},
  ahoge:{k:[300,190,130], c:[13,10, 8]},
  acc:  {k:[210,145,105], c:[16,12,10]},
};
function detectSide(name){
  if(!name) return null;
  if(/左/.test(name)) return "L";
  if(/右/.test(name)) return "R";
  if(/(^|[^a-z0-9])(l|left)([^a-z]|$)/i.test(name)) return "L";
  if(/(^|[^a-z0-9])(r|right)([^a-z]|$)/i.test(name)) return "R";
  return null;
}
function classify(name, groupName){
  const hay = name + " " + (groupName||"");
  for(const [re,role] of RULES)
    if(re.test(hay)) return {role, side: detectSide(name) || detectSide(groupName)};
  return {role:"other", side:null};
}
const PARAMS = [
  ["ParamAngleX","顔の角度X","顔の向き",-30,30,0], ["ParamAngleY","顔の角度Y","顔の向き",-30,30,0],
  ["ParamAngleZ","顔の傾き","顔の向き",-30,30,0],
  ["ParamEyeLOpen","左目 開閉","目",0,1,1],  ["ParamEyeROpen","右目 開閉","目",0,1,1],
  ["ParamEyeLSmile","左目 笑顔","目",0,1,0], ["ParamEyeRSmile","右目 笑顔","目",0,1,0],
  ["ParamEyeBallX","目玉X","目",-1,1,0],     ["ParamEyeBallY","目玉Y","目",-1,1,0],
  ["ParamBrowLY","左眉 上下","眉",-1,1,0],   ["ParamBrowRY","右眉 上下","眉",-1,1,0],
  ["ParamMouthOpenY","口 開閉","口",0,1,0],  ["ParamMouthForm","口 変形","口",-1,1,0],
  ["ParamCheek","頬の赤み","顔",0,1,0],
  ["ParamBodyAngleX","体の回転X","体",-10,10,0], ["ParamBodyAngleY","体の回転Y","体",-10,10,0],
  ["ParamBodyAngleZ","体の傾き","体",-10,10,0],  ["ParamBreath","呼吸","体",0,1,0],
  ["ParamBaseX","全体 左右","体",-10,10,0],      ["ParamBaseY","全体 上下","体",-10,10,0],
];

/* ===== physics / original lines 684-760 ===== */
function stepPhysics(M,dt){
  const drive  = P.ParamAngleZ.v/30 + P.ParamBodyAngleZ.v/10*0.45;
  const driveX = P.ParamAngleX.v/30*0.5 + P.ParamBodyAngleX.v/10*0.35;
  const driveY = P.ParamAngleY.v/30*0.35 + P.ParamBodyAngleY.v/10*0.25;
  const target0=(drive*0.34 + driveX*0.20 + driveY*0.10)*RIG.sway;
  const steps=clamp(Math.ceil(dt*240),1,24), h=dt/steps;
  for(const p of M.parts){
    if(!p.phys) continue;
    const ph=p.phys, base=target0*ph.seed;
    for(let s=0;s<steps;s++){
      let parent=base;
      for(let i=0;i<3;i++){
        const nd=ph.n[i];
        nd.v += (-ph.k[i]*(nd.a-parent) - ph.c[i]*nd.v)*h;
        nd.a += nd.v*h;
        parent=nd.a;
      }
    }
    let acc=0;
    for(let i=0;i<3;i++){
      const nd=ph.n[i];
      if(!isFinite(nd.a)||!isFinite(nd.v)){ nd.a=base; nd.v=0; }
      if(Math.abs(nd.a)>0.9){ nd.a=Math.sign(nd.a)*0.9; nd.v*=0.4; }
      acc+=nd.a*0.33;
      ph.cum[i+1]=clamp(acc,-0.42,0.42)*ph.lenK;
    }
  }
}

/* ===== idle-and-expressions / original lines 951-1037 ===== */
const IDLE={next:1.4,t:0,closing:0,gx:0,gy:0,tx:0,ty:0,gnext:0};
function idleTick(dt,t){
  P.ParamBreath.v=(Math.sin(t*1.15)+1)/2;
  const sway=Math.sin(t*0.42)*0.75+Math.sin(t*0.97+2.1)*0.18+Math.sin(t*1.83+0.7)*0.07;
  const sway2=Math.sin(t*0.31+1.3)*0.8+Math.sin(t*0.73+2.9)*0.2;
  P.ParamAngleZ.v=lerp(P.ParamAngleZ.v, sway*3.4, 0.05);
  P.ParamAngleX.v=lerp(P.ParamAngleX.v, sway2*4.2, 0.04);
  P.ParamAngleY.v=lerp(P.ParamAngleY.v, Math.sin(t*0.27+0.4)*2.2, 0.035);
  P.ParamBodyAngleZ.v=lerp(P.ParamBodyAngleZ.v, sway*1.2, 0.05);
  if(t>IDLE.gnext){
    IDLE.tx=(Math.random()*2-1)*0.5; IDLE.ty=(Math.random()*2-1)*0.28;
    IDLE.gnext=t+1.4+Math.random()*3.6;
  }
  IDLE.gx=lerp(IDLE.gx,IDLE.tx,1-Math.pow(0.0008,dt));
  IDLE.gy=lerp(IDLE.gy,IDLE.ty,1-Math.pow(0.0008,dt));
  P.ParamEyeBallX.v=IDLE.gx; P.ParamEyeBallY.v=IDLE.gy;
  IDLE.t+=dt;
  if(IDLE.t>IDLE.next){ IDLE.closing=0.16; IDLE.t=0; IDLE.next=1.6+Math.random()*4.2; }
  if(IDLE.closing>0){
    IDLE.closing-=dt;
    P.ParamEyeLOpen.v=P.ParamEyeROpen.v=1-Math.sin(clamp(IDLE.closing/0.16,0,1)*Math.PI);
  }else if(P.ParamEyeLOpen.v<1){
    P.ParamEyeLOpen.v=P.ParamEyeROpen.v=Math.min(1,P.ParamEyeLOpen.v+dt*7);
  }
}
const EXPR=[
  {k:"1", n:"笑顔",     p:{ParamEyeLSmile:1, ParamEyeRSmile:1, ParamMouthForm:0.9, ParamCheek:0.55}},
  {k:"2", n:"驚き",     p:{ParamEyeLOpen:1, ParamEyeROpen:1, ParamBrowLY:1, ParamBrowRY:1,
                           ParamMouthOpenY:0.7, ParamMouthForm:-0.2}},
  {k:"3", n:"にっこり", p:{ParamEyeLOpen:0, ParamEyeROpen:0, ParamEyeLSmile:1, ParamEyeRSmile:1,
                           ParamMouthForm:1, ParamCheek:0.4}},
  {k:"4", n:"照れ",     p:{ParamCheek:1, ParamBrowLY:-0.35, ParamBrowRY:-0.35, ParamMouthForm:0.35,
                           ParamEyeLOpen:0.75, ParamEyeROpen:0.75}},
  {k:"5", n:"困り",     p:{ParamBrowLY:-1, ParamBrowRY:-1, ParamMouthForm:-0.85,
                           ParamEyeLOpen:0.8, ParamEyeROpen:0.8}},
  {k:"6", n:"ジト目",   p:{ParamEyeLOpen:0.42, ParamEyeROpen:0.42, ParamBrowLY:-0.6, ParamBrowRY:-0.6,
                           ParamMouthForm:-0.3}},
];
let exprCur=null, exprW=0, exprBase=null;
function applyExpr(dt){
  const tgt=exprCur?1:0;
  exprW += (tgt-exprW)*(1-Math.exp(-dt/0.06));
  if(exprW<0.002){
    exprW=0;
    if(!exprCur){ exprBase=null; return; }
  }
  if(!exprBase) return;
  const driven = !!TR || demo || $("#idle").checked;
  for(const id in exprBase){
    const pr=P[id]; if(!pr) continue;
    const base = driven ? pr.v : exprBase[id];
    const to = (exprCur && exprCur.p[id]!=null) ? clamp(exprCur.p[id],pr.mn,pr.mx) : base;
    pr.v = lerp(base, to, exprW);
  }
}

/* ===== frame-order / original lines 2825-2848 ===== */
function frame(now){
  if(!MODEL||!gl) return;
  loopErr=0;
  const dt=clamp((now-tPrev)/1000,0.0005,0.05); tPrev=now;
  if(demo){ demoTick((now-t0)/1000); syncSliders(); }
  else if($("#idle").checked && !TR) idleTick(dt,(now-t0)/1000);
  else if(RELAX && !TR){
    if(now-RELAX>900) RELAX=0;
    else { for(const [id] of PARAMS) P[id].v=lerp(P[id].v,P[id].df,1-Math.pow(0.02,dt)); syncSliders(); }
  }
  trackTick(now);
  if(TR) trackEase(dt);
  if(exprCur||exprW>0){ applyExpr(dt); syncSliders(); }
  stepPhysics(MODEL,dt);
  const sig = HILITE ? -1 : sceneSig(MODEL);
  const still = (sig!==-1 && sig===sigPrev && !needResize);
  if(!still){ render(MODEL); sigPrev=sig; drawn++; }
  frames++;
}

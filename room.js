// Комната игры «Лучник»: места, очерёдность, здоровье, деревья, запас стрел, бонусы.
// Работает в браузере создателя игры. Остальные игроки подключаются к нему через WebRTC (P2P)
// или через пересылку server.py, а сам создатель — через «петлю» в памяти.
// Результат выстрела считает стрелявший; комната его применяет и рассылает всем,
// поэтому у всех одинаковое состояние, а вернувшийся после обрыва получает его целиком.
(function(root){
'use strict';
const WIND_MAX=6.0;
const HP_MAX=100;
const RECONNECT_GRACE=180; // сколько секунд держим место ушедшего игрока
const BOT_DELAY=8;         // через сколько секунд за отошедшего игрока начинает играть бот (если боты включены)
const SLOT_ORDER=['L0','R0','L1','R1'];
const ID_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O и 1/I

function team(sid){return sid[0]==='L'?'left':'right'}
function other(t){return t==='left'?'right':'left'}
function randBytes(n){const b=new Uint8Array(n);crypto.getRandomValues(b);return b}
function newToken(){return Array.from(randBytes(16),x=>x.toString(16).padStart(2,'0')).join('')}
function randomGameId(){let s='';for(const x of randBytes(6))s+=ID_CHARS[x%ID_CHARS.length];return s}
function toInt(v){const n=Math.trunc(Number(v));return Number.isFinite(n)?n:0}
function isNum(v){return typeof v==='number'&&Number.isFinite(v)}

const AMMO_START={fire:1,heavy:2,triple:1}; // особые стрелы на раунд
const ARROW_KINDS=['fire','heavy','triple'];
const BONUSES=['fire','heavy','triple','shield','power','heal']; // что бывает в ящике
const BURN_TURNS=2;   // подожжённое дерево сгорает через столько ходов
const WEATHERS=['clear','clear','gusty','rain','fog']; // погода раунда (ясно — чаще)
const HATS=['none','cap','hood','feather','helmet','viking','crown']; // внешний вид: шапка…
const FLETCH=['team','gold','rainbow','black'];                       // …и оперение стрел
function cleanSkin(k){k=k||{};return {hat:HATS.includes(k.hat)?k.hat:'none',fletch:FLETCH.includes(k.fletch)?k.fletch:'team'}}
// Вместе против ИИ: справа — боты, их больше и они крепче с каждой волной
function coopBots(wave){return wave>=3?['R0','R1']:['R0']}
function botHp(wave){return Math.min(HP_MAX,55+15*wave)}

function newWind(prev,enabled,weather){
  if(!enabled)return 0;
  // порывистый ветер: сильнее и меняется резче
  const max=weather==='gusty'?9:WIND_MAX,keep=weather==='gusty'?0.15:0.35;
  const w=prev*keep+(Math.random()*2-1)*max*0.8;
  return Math.round(Math.max(-max,Math.min(max,w))*10)/10;
}
function cleanOpts(o){
  o=o||{};
  const flag=v=>v===undefined?true:!!v;
  return {
    wind:flag(o.wind),
    birds:flag(o.birds),
    trees:['none','few','many'].includes(o.trees)?o.trees:'few',
    diff:['easy','normal','hard'].includes(o.diff)?o.diff:'normal',
    size:o.size===2?2:1,
    bots:flag(o.bots),
    timer:[0,20,30,45].includes(o.timer)?o.timer:0, // секунд на ход, 0 — без ограничения
    specials:flag(o.specials), // особые стрелы
    crates:flag(o.crates),     // ящики с бонусами
    weather:flag(o.weather),   // случайная погода на раунд
    cover:flag(o.cover),       // камни и кусты
    wins:[0,3,5].includes(o.wins)?o.wins:0, // матч до стольких побед (0 — без счёта)
    coop:!!o.coop,             // вместе против волн ИИ (size — сколько людей)
  };
}
function cleanName(n){return String(n==null?'':n).trim().slice(0,14)}
function newSlot(){return {kind:'empty',ws:null,token:null,name:'',online:false,tasks:[],skin:cleanSkin()}}

// ---------- состояние раунда ----------

function members(g,t){return g.active.filter(s=>team(s)===t)}
function playable(g,sid){return (g.hp[sid]||0)>0&&g.slots[sid].kind!=='gone'}

function nextTurn(g,cur){
  // команды ходят по очереди, внутри команды бойцы — по кругу
  const t=team(cur);
  for(const tt of [other(t),t]){
    const m=members(g,tt);
    if(!m.some(s=>playable(g,s)))continue;
    const last=g.last_idx[tt];
    for(let k=1;k<=m.length;k++){
      const s=m[((last+k)%m.length+m.length)%m.length];
      if(playable(g,s))return s;
    }
  }
  return cur;
}
function setTurn(g,sid){
  g.turn=sid;
  g.last_idx[team(sid)]=members(g,team(sid)).indexOf(sid);
}
function newRound(g){
  g.seed=1+Math.floor(Math.random()*2147000000);
  const prev=g.hp||{},coop=g.opts.coop;
  if(coop)g.active=g.active.filter(s=>team(s)==='left').concat(coopBots(g.wave));
  g.hp={};g.pos={};
  for(const s of g.active){
    g.pos[s]=null;
    if(!coop)g.hp[s]=HP_MAX;
    else if(team(s)==='right')g.hp[s]=botHp(g.wave);
    // люди переходят в следующую волну со своим здоровьем +30; павший встаёт с половиной
    else g.hp[s]=g.wave>1?(prev[s]>0?Math.min(HP_MAX,prev[s]+30):50):HP_MAX;
  }
  g.over=false;g.winner=null;g.shot=false;
  g.last_idx={left:-1,right:-1};
  g.turn_no=0;  // сколько ходов прошло: от него зависит рост деревьев
  g.trees={};   // деревья: номер -> {dmg, felled, felled_at, dmg_fell, burn_at}
  // у каждого бойца: запас особых стрел, щит на одно попадание, двойной урон на следующий выстрел
  g.st={};
  for(const s of g.active)g.st[s]={ammo:g.opts.specials?Object.assign({},AMMO_START):{fire:0,heavy:0,triple:0},shield:0,power:0};
  g.weather=g.opts.weather?WEATHERS[Math.floor(Math.random()*WEATHERS.length)]:'clear';
  const first=members(g,g.starter);
  setTurn(g,(first.length?first:g.active)[0]);
  g.wind=newWind(0,g.opts.wind,g.weather);
}
function leader(g){
  // «ведущий» — первый игрок на связи: он управляет ботами и птицами
  for(const s of SLOT_ORDER){
    const sl=g.slots[s];
    if(sl&&sl.kind==='human'&&sl.online)return s;
  }
  return null;
}
function slotsView(g){
  const v={};
  for(const s in g.slots){
    const sl=g.slots[s];
    v[s]={name:sl.name,kind:sl.kind,online:sl.online,away:sl.kind==='bot'&&sl.token!==null,skin:sl.skin||cleanSkin()};
  }
  return v;
}
function startPayload(g){
  return {type:'game_started',seed:g.seed,wind:g.wind,turn:g.turn,opts:g.opts,score:g.score,active:g.active,
    turn_no:g.turn_no,trees:g.trees,st:g.st,weather:g.weather,hp:g.hp,wave:g.wave,match_over:g.match_over,
    slots:slotsView(g),leader:leader(g)};
}
function fullState(g,sid){
  const msg={type:'resumed',game_id:g.id,slot:sid,size:g.opts.size,bots:g.opts.bots,
    started:g.started,slots:slotsView(g),leader:leader(g)};
  if(g.started){
    const p=startPayload(g);delete p.type;
    Object.assign(msg,p,{pos:g.pos,over:g.over,winner:g.winner,shot:g.shot});
  }
  return msg;
}
function freeSlotForJoin(g){
  if(!g.started){
    for(const s of SLOT_ORDER)if(g.slots[s]&&g.slots[s].kind==='empty')return s;
    return null;
  }
  // в идущей игре можно занять место бота или ушедшего (в кооперативе — только среди людей)
  for(const s of g.active){
    const sl=g.slots[s];
    if(g.opts.coop&&team(s)==='right')continue;
    if(sl.token===null&&(sl.kind==='bot'||sl.kind==='gone'))return s;
  }
  return null;
}
function startGame(g){
  const active=[];
  for(const s of SLOT_ORDER){
    const sl=g.slots[s];
    if(!sl||(g.opts.coop&&team(s)==='right'))continue; // ботов справа добавит newRound по номеру волны
    if(sl.kind==='human')active.push(s);
    else if(g.opts.bots){sl.kind='bot';active.push(s)}
  }
  if(g.opts.coop)active.push(...coopBots(g.wave));
  if(!active.some(s=>team(s)==='left')||!active.some(s=>team(s)==='right'))return false;
  g.active=active;g.started=true;
  newRound(g);
  return true;
}
function allHumans(g){return Object.keys(g.slots).every(s=>(g.opts.coop&&team(s)==='right')||g.slots[s].kind==='human')}
function canControl(g,me,sid){
  if(!(sid in g.slots))return false;
  if(sid===me)return true;
  return g.slots[sid].kind==='bot'&&leader(g)===me;
}
function cancelTasks(sl){for(const t of sl.tasks)clearTimeout(t);sl.tasks=[]}
function gameDead(g){return Object.values(g.slots).every(sl=>sl.token===null)}

// ---------- комнаты ----------
// conn — любое соединение с методами send(obj) и close().
// hub.connect(conn) возвращает {message(data), closed()}: их вызывает транспорт.
class ArcherHub{
  constructor(o){
    o=o||{};
    this.games={};
    this.log=o.log||(()=>{});
    this.onChange=o.onChange||null;   // состояние игры изменилось (для сохранения)
    this.onClosed=o.onClosed||null;   // игра закрыта
  }

  connect(conn){
    const c={conn,g:null,me:null,emoteAt:0};
    return {
      message:data=>{try{this._message(c,data)}catch(e){this.log('[!] Ошибка: '+e)}},
      closed:()=>{try{this._closed(c)}catch(e){this.log('[!] Ошибка: '+e)}},
    };
  }

  // ---------- отправка ----------
  send(ws,msg){
    if(!ws)return;
    try{ws.send(msg)}catch(e){}
  }
  broadcast(g,msg,exclude){
    for(const sl of Object.values(g.slots))if(sl.ws&&sl.ws!==exclude)this.send(sl.ws,msg);
  }
  sendSlots(g){
    if(g.started)this.broadcast(g,{type:'slots',slots:slotsView(g),leader:leader(g)});
    else this.broadcast(g,{type:'lobby',game_id:g.id,slots:slotsView(g),leader:leader(g),size:g.opts.size,bots:g.opts.bots});
  }
  changed(g){if(this.onChange&&this.games[g.id]===g)this.onChange(g)}

  // одно попадание (у тройной стрелы их до трёх)
  applyHit(g,shooter,r){
    if(!r||typeof r!=='object')return;
    const hp=g.hp,st=g.st||{},has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
    if(r.kind==='player'&&has(hp,r.id)){
      const s=st[r.id];
      if(s&&s.shield){s.shield=0;return} // щит принимает удар на себя
      hp[r.id]=Math.max(0,hp[r.id]-Math.max(0,Math.min(150,toInt(r.dmg))));
    }else if(r.kind==='bird'&&has(hp,shooter)){
      hp[shooter]=Math.min(HP_MAX,hp[shooter]+Math.max(0,Math.min(25,toInt(r.heal))));
    }else if(r.kind==='tree'&&Number.isInteger(r.tree)&&r.tree>=0&&r.tree<8){
      // деревья считает стрелявший, комната только запоминает — для тех, кто переподключится
      const t=g.trees[r.tree]||(g.trees[r.tree]={dmg:0,felled:false});
      t.dmg+=Math.max(0,Math.min(200,toInt(r.tdmg)));
      // когда срубили — из пня через несколько ходов вырастет новое (это считают сами игроки по felled_at)
      if(r.felled){t.felled=true;t.felled_at=g.turn_no;t.dmg_fell=t.dmg;t.burn_at=null}
      else if(r.fire&&t.burn_at==null)t.burn_at=g.turn_no; // огненная стрела подожгла
    }else if(r.kind==='crate'&&has(st,shooter)&&BONUSES.includes(r.bonus)){
      const s=st[shooter];
      if(r.bonus==='heal')hp[shooter]=Math.min(HP_MAX,hp[shooter]+20);
      else if(r.bonus==='shield')s.shield=1;
      else if(r.bonus==='power')s.power=1;
      else s.ammo[r.bonus]+=r.bonus==='heavy'?2:1;
    }
  }
  finishTurn(g,result){
    // применяет результат выстрела текущего бойца и передаёт ход
    const hp=g.hp,shooter=g.turn;
    const hits=result&&result.kind==='multi'?(Array.isArray(result.hits)?result.hits.slice(0,3):[]):[result];
    for(const r of hits)this.applyHit(g,shooter,r);
    g.shot=false;
    const alive={};
    for(const t of ['left','right'])alive[t]=members(g,t).some(s=>hp[s]>0);
    if(!alive.left||!alive.right){
      g.over=true;
      g.winner=alive.left?'left':'right';
      g.score[g.winner]++;
      // кооператив: отбились — следующая волна, пали — забег окончен; иначе матч до N побед
      if(g.opts.coop){if(g.winner==='left')g.wave++;else g.match_over=true}
      else if(g.opts.wins&&g.score[g.winner]>=g.opts.wins)g.match_over=true;
    }else{
      setTurn(g,nextTurn(g,shooter));
      g.wind=newWind(g.wind,g.opts.wind,g.weather);
      g.turn_no++;
      // подожжённые деревья догорают
      for(const i in g.trees){
        const t=g.trees[i];
        if(t.burn_at!=null&&g.turn_no>=t.burn_at+BURN_TURNS){t.felled=true;t.felled_at=g.turn_no;t.dmg_fell=t.dmg;t.burn_at=null}
      }
    }
    this.broadcast(g,{type:'turn_result',result,hp,turn:g.turn,wind:g.wind,
      game_over:g.over,winner:g.winner,score:g.score,turn_no:g.turn_no,trees:g.trees,st:g.st,wave:g.wave,match_over:g.match_over});
  }
  dropPendingShot(g){
    // выстрел «повис» (стрелявший пропал) — засчитываем промах, чтобы игра не встала
    if(g.started&&g.shot&&!g.over)this.finishTurn(g,{kind:'out',x:-100,y:0,ang:0,steps:0});
  }
  skipIfUnplayable(g){
    // ход у бойца, за которого некому играть (ушёл, ботов нет) — передаём ход дальше
    if(g.started&&!g.over&&!g.shot&&g.slots[g.turn].kind==='gone')this.finishTurn(g,null);
  }
  releaseSlot(g,sid){
    // игрок ушёл насовсем: место освобождается (в игре — бот или пусто)
    const sl=g.slots[sid];
    cancelTasks(sl);
    sl.token=null;sl.ws=null;sl.online=false;
    if(!g.started){sl.kind='empty';sl.name=''}
    else if(g.active.includes(sid)){
      sl.kind=g.opts.bots?'bot':'gone';
      if(sl.kind==='bot')sl.name='';
    }else sl.kind='empty';
  }
  afterLeave(g){
    if(gameDead(g)){
      this.closeGame(g);
      return;
    }
    this.skipIfUnplayable(g);
    this.sendSlots(g);
  }
  closeGame(g){
    for(const sl of Object.values(g.slots))cancelTasks(sl);
    if(this.games[g.id]!==g)return;
    delete this.games[g.id];
    this.log(`[-] Игра ${g.id} закрыта`);
    if(this.onClosed)this.onClosed(g.id);
  }
  awayTimer(g,sid,token){
    const sl=g.slots[sid];
    const giveUp=()=>{
      if(sl.token===token&&!sl.online){
        this.log(`[-] Игрок ${sid} не вернулся в игру ${g.id}`);
        if(g.shot&&g.turn===sid)this.dropPendingShot(g);
        this.releaseSlot(g,sid);
        this.afterLeave(g);
        this.changed(g);
      }
    };
    if(g.opts.bots&&g.started){
      sl.tasks.push(setTimeout(()=>{
        if(sl.token===token&&!sl.online&&sl.kind==='human'){
          // за отошедшего пока играет бот; вернётся — получит управление обратно
          if(g.shot&&g.turn===sid)this.dropPendingShot(g);
          sl.kind='bot';
          this.sendSlots(g);
          this.changed(g);
        }
        sl.tasks.push(setTimeout(giveUp,(RECONNECT_GRACE-BOT_DELAY)*1000));
      },BOT_DELAY*1000));
    }else sl.tasks.push(setTimeout(giveUp,RECONNECT_GRACE*1000));
  }

  // ---------- сообщения ----------
  _message(c,data){
    if(!data||typeof data!=='object')return;
    const ws=c.conn,action=data.action;
    let g=c.g,me=c.me;

    if(action==='ping'){
      this.send(ws,{type:'pong'});
    }else if(action==='create_game'){
      // в P2P код игры выбирает хост (от него зависит адрес для подключения)
      let gid=String(data.game_id||'').toUpperCase();
      if(!/^[A-Z0-9]{6}$/.test(gid)||this.games[gid])gid=randomGameId();
      while(this.games[gid])gid=randomGameId();
      const o=cleanOpts(data.opts);
      // кооператив: слева люди (1–2), справа два места ботов
      const ids=o.coop?(o.size===2?['L0','L1','R0','R1']:['L0','R0','R1']):(o.size===2?SLOT_ORDER:['L0','R0']);
      g={id:gid,opts:o,slots:{},active:[],started:false,score:{left:0,right:0},starter:'left',wave:1,match_over:false};
      for(const s of ids){g.slots[s]=newSlot();if(o.coop&&team(s)==='right'){g.slots[s].kind='bot';g.slots[s].name='ИИ'}}
      me='L0';
      const sl=g.slots[me];
      Object.assign(sl,{kind:'human',ws,token:newToken(),name:cleanName(data.name)||'Игрок 1',online:true,skin:cleanSkin(data.skin)});
      this.games[gid]=g;
      c.g=g;c.me=me;
      this.send(ws,{type:'joined',game_id:gid,slot:me,token:sl.token});
      this.sendSlots(g);
      this.log(`[+] Игра ${gid} создана (${o.size} на ${o.size})`);
    }else if(action==='join_game'){
      const gid=String(data.game_id||'').toUpperCase();
      const gg=this.games[gid];
      const sid=gg?freeSlotForJoin(gg):null;
      if(!sid){this.send(ws,{type:'error',message:'Игра не найдена или мест нет'});return}
      g=gg;me=sid;c.g=g;c.me=me;
      const sl=g.slots[me];
      const n=Object.values(g.slots).filter(s=>s.token).length+1;
      Object.assign(sl,{kind:'human',ws,token:newToken(),name:cleanName(data.name)||`Игрок ${n}`,online:true,skin:cleanSkin(data.skin)});
      this.send(ws,{type:'joined',game_id:gid,slot:me,token:sl.token});
      this.log(`[+] Игрок вошёл в ${gid} на место ${me}`);
      if(g.started){
        this.send(ws,fullState(g,me));
        this.sendSlots(g);
      }else if(allHumans(g)){
        startGame(g);
        this.broadcast(g,startPayload(g));
      }else this.sendSlots(g);
    }else if(action==='resume'){
      const gid=String(data.game_id||'').toUpperCase();
      const sid=data.slot;
      const gg=this.games[gid];
      if(!gg||!(sid in gg.slots)||gg.slots[sid].token===null||gg.slots[sid].token!==data.token){
        this.send(ws,{type:'resume_failed'});
        return;
      }
      g=gg;me=sid;c.g=g;c.me=me;
      const sl=g.slots[me];
      const old=sl.ws;
      cancelTasks(sl);
      Object.assign(sl,{ws,online:true,kind:'human'});
      if(data.skin)sl.skin=cleanSkin(data.skin);
      if(old&&old!==ws){try{old.close()}catch(e){}}
      this.send(ws,fullState(g,me));
      this.sendSlots(g);
      this.log(`[~] Игрок ${me} вернулся в игру ${gid}`);
    }else if(!g){
      return;
    }else if(action==='start_game'){
      if(!g.started&&leader(g)===me){
        if(startGame(g))this.broadcast(g,startPayload(g));
        else this.send(ws,{type:'error',message:'Нужен хотя бы один игрок в каждой команде (или включите ботов)'});
      }
    }else if(action==='state'){
      const sid=data.id;
      if(g.started&&g.turn===sid&&!g.over&&!g.shot&&canControl(g,me,sid)){
        if(isNum(data.x))g.pos[sid]=data.x;
        this.broadcast(g,{type:'remote_state',id:sid,x:data.x,angle:data.angle,draw:data.draw},ws);
      }
    }else if(action==='shoot'){
      const sid=data.id;
      if(!g.started||g.over||g.shot||g.turn!==sid||!canControl(g,me,sid))return;
      g.shot=true;
      if(isNum(data.x))g.pos[sid]=data.x;
      // особая стрела тратит запас; двойной урон расходуется на этот выстрел
      const kind=ARROW_KINDS.includes(data.kind)?data.kind:'normal',s=g.st&&g.st[sid];
      if(s&&kind!=='normal')s.ammo[kind]=Math.max(0,s.ammo[kind]-1);
      const power=!!(s&&s.power);if(s)s.power=0;
      this.broadcast(g,{type:'arrow_shot',id:sid,x:data.x,angle:data.angle,draw:data.draw,no:data.no,kind,power},ws);
    }else if(action==='skip'){
      // время на ход вышло, а лук не натянут — ход переходит дальше
      const sid=data.id;
      if(g.started&&!g.over&&!g.shot&&g.turn===sid&&canControl(g,me,sid))this.finishTurn(g,{kind:'skip'});
    }else if(action==='emote'){
      // быстрая фраза над лучником; не чаще раза в секунду, чтобы не заспамили
      const now=Date.now(),e=toInt(data.e);
      if(g.started&&now-c.emoteAt>1000&&e>=0&&e<16){c.emoteAt=now;this.broadcast(g,{type:'emote',id:me,e},ws)}
    }else if(action==='bird_spawn'){
      if(leader(g)===me)this.broadcast(g,{type:'bird_spawn',birds:data.birds||[]},ws);
    }else if(action==='crate_spawn'){
      if(leader(g)===me&&g.opts.crates&&data.crate)this.broadcast(g,{type:'crate_spawn',crate:data.crate},ws);
    }else if(action==='arrow_result'){
      const sid=data.id;
      if(g.started&&!g.over&&g.shot&&g.turn===sid&&canControl(g,me,sid))this.finishTurn(g,data.result||{});
    }else if(action==='restart'){
      if(g.started){
        if(g.match_over){g.score={left:0,right:0};g.wave=1;g.match_over=false;g.starter='left'} // новый матч / забег
        else if(g.opts.coop)g.starter='left';                // в кооперативе первыми всегда ходят люди
        else if(g.over)g.starter=other(g.winner);             // следующий раунд начинает проигравшая команда
        newRound(g);
        this.broadcast(g,startPayload(g));
      }
    }else if(action==='leave'){
      if(g.slots[me].ws===ws){
        if(g.shot&&canControl(g,me,g.turn))this.dropPendingShot(g);
        this.releaseSlot(g,me);
        this.afterLeave(g);
      }
      this.changed(g);
      c.g=null;c.me=null;
      return;
    }
    if(c.g)this.changed(c.g);
  }

  _closed(c){
    const g=c.g,me=c.me;
    if(!g||!me||g.slots[me].ws!==c.conn)return;
    const sl=g.slots[me];
    const wasLeader=leader(g)===me;
    sl.ws=null;sl.online=false;
    // стрелял бот этого игрока — результат уже не придёт
    if(wasLeader&&g.shot&&g.slots[g.turn].kind==='bot')this.dropPendingShot(g);
    this.awayTimer(g,me,sl.token);
    this.sendSlots(g);
    this.changed(g);
  }

  // ---------- для хоста P2P ----------
  // Хост закрывает игру: всем сообщаем и рвём соединения
  shutdown(gid){
    const g=this.games[gid];
    if(!g)return;
    for(const sl of Object.values(g.slots)){
      if(sl.ws){const ws=sl.ws;sl.ws=null;this.send(ws,{type:'game_closed'});try{ws.close()}catch(e){}}
    }
    this.closeGame(g);
  }
  // Снимок игры без соединений и таймеров — чтобы пережить перезагрузку вкладки хоста
  snapshot(gid){
    const g=this.games[gid];
    if(!g)return null;
    const slots={};
    for(const s in g.slots){const sl=g.slots[s];slots[s]={kind:sl.kind,token:sl.token,name:sl.name,skin:sl.skin}}
    return JSON.parse(JSON.stringify(Object.assign({},g,{slots})));
  }
  restore(snap){
    const g=JSON.parse(JSON.stringify(snap));
    if(g.started){g.trees=g.trees||{};g.turn_no=g.turn_no||0;g.st=g.st||{};g.weather=g.weather||'clear'} // снимок от прошлой версии
    g.wave=g.wave||1;g.match_over=!!g.match_over;
    for(const s in g.slots)Object.assign(g.slots[s],{ws:null,online:false,tasks:[]});
    this.games[g.id]=g;
    // все пока «отошли»: кто не вернётся вовремя — уступит место боту, как при обрыве связи
    for(const s in g.slots){const sl=g.slots[s];if(sl.token)this.awayTimer(g,s,sl.token)}
    return g;
  }
}

ArcherHub.randomGameId=randomGameId;
root.ArcherHub=ArcherHub;
if(typeof module!=='undefined'&&module.exports)module.exports=ArcherHub;
})(typeof window!=='undefined'?window:globalThis);

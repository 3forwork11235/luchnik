// Комната игры «Лучник» — та же логика, что в server.py, только на JS.
// В режиме P2P она работает прямо в браузере создателя игры: остальные игроки
// подключаются к нему через WebRTC, а сам создатель — через «петлю» в памяти.
// Протокол сообщений тот же, что у server.py, поэтому клиенту всё равно, кто сервер.
// Если поменяли правила здесь — поменяйте и в server.py (он остался запасным вариантом).
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

function newWind(prev,enabled){
  if(!enabled)return 0;
  const w=prev*0.35+(Math.random()*2-1)*WIND_MAX*0.8;
  return Math.round(Math.max(-WIND_MAX,Math.min(WIND_MAX,w))*10)/10;
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
  };
}
function cleanName(n){return String(n==null?'':n).trim().slice(0,14)}
function newSlot(){return {kind:'empty',ws:null,token:null,name:'',online:false,tasks:[]}}

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
  g.hp={};g.pos={};
  for(const s of g.active){g.hp[s]=HP_MAX;g.pos[s]=null}
  g.over=false;g.winner=null;g.shot=false;
  g.last_idx={left:-1,right:-1};
  const first=members(g,g.starter);
  setTurn(g,(first.length?first:g.active)[0]);
  g.wind=newWind(0,g.opts.wind);
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
    v[s]={name:sl.name,kind:sl.kind,online:sl.online,away:sl.kind==='bot'&&sl.token!==null};
  }
  return v;
}
function startPayload(g){
  return {type:'game_started',seed:g.seed,wind:g.wind,turn:g.turn,opts:g.opts,score:g.score,active:g.active,
    slots:slotsView(g),leader:leader(g)};
}
function fullState(g,sid){
  const msg={type:'resumed',game_id:g.id,slot:sid,size:g.opts.size,bots:g.opts.bots,
    started:g.started,slots:slotsView(g),leader:leader(g)};
  if(g.started){
    const p=startPayload(g);delete p.type;
    Object.assign(msg,p,{hp:g.hp,pos:g.pos,over:g.over,winner:g.winner,shot:g.shot});
  }
  return msg;
}
function freeSlotForJoin(g){
  if(!g.started){
    for(const s of SLOT_ORDER)if(g.slots[s]&&g.slots[s].kind==='empty')return s;
    return null;
  }
  // в идущей игре можно занять место бота или ушедшего
  for(const s of g.active){
    const sl=g.slots[s];
    if(sl.token===null&&(sl.kind==='bot'||sl.kind==='gone'))return s;
  }
  return null;
}
function startGame(g){
  const active=[];
  for(const s of SLOT_ORDER){
    const sl=g.slots[s];
    if(!sl)continue;
    if(sl.kind==='human')active.push(s);
    else if(g.opts.bots){sl.kind='bot';active.push(s)}
  }
  if(!active.some(s=>team(s)==='left')||!active.some(s=>team(s)==='right'))return false;
  g.active=active;g.started=true;
  newRound(g);
  return true;
}
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
    const c={conn,g:null,me:null};
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

  finishTurn(g,result){
    // применяет результат выстрела текущего бойца и передаёт ход
    const hp=g.hp,shooter=g.turn;
    if(result){
      const kind=result.kind;
      if(kind==='player'&&Object.prototype.hasOwnProperty.call(hp,result.id)){
        const dmg=Math.max(0,Math.min(80,toInt(result.dmg)));
        hp[result.id]=Math.max(0,hp[result.id]-dmg);
      }else if(kind==='bird'&&shooter in hp){
        const heal=Math.max(0,Math.min(15,toInt(result.heal)));
        hp[shooter]=Math.min(HP_MAX,hp[shooter]+heal);
      }
    }
    g.shot=false;
    const alive={};
    for(const t of ['left','right'])alive[t]=members(g,t).some(s=>hp[s]>0);
    if(!alive.left||!alive.right){
      g.over=true;
      g.winner=alive.left?'left':'right';
      g.score[g.winner]++;
    }else{
      setTurn(g,nextTurn(g,shooter));
      g.wind=newWind(g.wind,g.opts.wind);
    }
    this.broadcast(g,{type:'turn_result',result,hp,turn:g.turn,wind:g.wind,
      game_over:g.over,winner:g.winner,score:g.score});
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
      const ids=o.size===2?SLOT_ORDER:['L0','R0'];
      g={id:gid,opts:o,slots:{},active:[],started:false,score:{left:0,right:0},starter:'left'};
      for(const s of ids)g.slots[s]=newSlot();
      me='L0';
      const sl=g.slots[me];
      Object.assign(sl,{kind:'human',ws,token:newToken(),name:cleanName(data.name)||'Игрок 1',online:true});
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
      Object.assign(sl,{kind:'human',ws,token:newToken(),name:cleanName(data.name)||`Игрок ${n}`,online:true});
      this.send(ws,{type:'joined',game_id:gid,slot:me,token:sl.token});
      this.log(`[+] Игрок вошёл в ${gid} на место ${me}`);
      if(g.started){
        this.send(ws,fullState(g,me));
        this.sendSlots(g);
      }else if(Object.values(g.slots).every(s=>s.kind==='human')){
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
      this.broadcast(g,{type:'arrow_shot',id:sid,x:data.x,angle:data.angle,draw:data.draw,no:data.no},ws);
    }else if(action==='bird_spawn'){
      if(leader(g)===me)this.broadcast(g,{type:'bird_spawn',birds:data.birds||[]},ws);
    }else if(action==='arrow_result'){
      const sid=data.id;
      if(g.started&&!g.over&&g.shot&&g.turn===sid&&canControl(g,me,sid))this.finishTurn(g,data.result||{});
    }else if(action==='restart'){
      if(g.started){
        if(g.over)g.starter=other(g.winner); // следующий раунд начинает проигравшая команда
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
    for(const s in g.slots){const sl=g.slots[s];slots[s]={kind:sl.kind,token:sl.token,name:sl.name}}
    return JSON.parse(JSON.stringify(Object.assign({},g,{slots})));
  }
  restore(snap){
    const g=JSON.parse(JSON.stringify(snap));
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

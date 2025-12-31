/**
 * EZERBOT – TODO QUESO
 * BOT VENDEDOR + CATÁLOGO CARRUSEL + SELLITOS + REFERIDOS
 * SCRIPT ÚNICO – FINAL
 */

import express from "express";
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL.replace(/\/$/, "");
const DATA_API_URL = process.env.DATA_API_URL.replace(/\/$/, "");
let BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "");

const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

/* ---------------- API TELEGRAM ---------------- */
async function tg(method, payload) {
  const r = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return r.json();
}
const send = (id, t, e={}) => tg("sendMessage",{chat_id:id,text:t,parse_mode:"HTML",...e});
const photo = (id,p,c,e={}) => tg("sendPhoto",{chat_id:id,photo:p,caption:c,parse_mode:"HTML",...e});
const editMedia = (id,mid,p,c,e={})=>tg("editMessageMedia",{chat_id:id,message_id:mid,media:{type:"photo",media:p,caption:c,parse_mode:"HTML"},...e});
const editKb = (id,mid,k)=>tg("editMessageReplyMarkup",{chat_id:id,message_id:mid,reply_markup:k});

/* ---------------- DATA ---------------- */
async function fetchData(type){
  const r = await fetch(`${DATA_API_URL}?type=${type}`);
  return r.json();
}

/* ---------------- ESTADOS ---------------- */
const state = new Map();
const cart = new Map();
const stamps = new Map();

/* ---------------- MENÚ ---------------- */
const mainMenu = {
  keyboard:[
    [{text:"🛍️ Catálogo"}],
    [{text:"🏷️ Sellos"},{text:"📣 Compartir bot"}],
    [{text:"🆘 Ayuda"}]
  ],
  resize_keyboard:true
};

/* ---------------- START ---------------- */
async function start(chat, payload=""){
  const cfg = await fetchData("config");
  const msg =
`👋 <b>${cfg.NegocioNombre}</b>

${cfg.Descripcion}

📍 ${cfg.NegocioDireccion}
🕒 ${cfg.NegocioHorario}
📲 ${cfg.NegocioTelefono}

👉 Elegí una opción abajo 👇`;

  if(cfg.LogoURL){
    await photo(chat,cfg.LogoURL,msg,{reply_markup:mainMenu});
  }else{
    await send(chat,msg,{reply_markup:mainMenu});
  }

  if(payload.startsWith("P_")){
    showSharedProduct(chat,payload.replace("P_",""));
  }
}

/* ---------------- CATÁLOGO ---------------- */
async function showCategories(chat){
  const cat = await fetchData("catalog");
  const cats = [...new Set(cat.items.map(i=>i.categoria))];
  const kb = {inline_keyboard:cats.map(c=>[{text:c,callback_data:`CAT_${c}`}])};
  send(chat,"📚 Elegí una categoría",{reply_markup:kb});
}

async function showProduct(chat, list, i){
  const it = list[i];
  const caption =
`🧀 <b>${it.nombre}</b>
💰 $ ${it.precio} (${it.unidad})

${it.descripcion}

📌 ${i+1}/${list.length}`;

  const kb = {
    inline_keyboard:[
      [{text:"⬅️",callback_data:"PREV"},{text:"➡️",callback_data:"NEXT"}],
      [{text:"🟢 Quiero este",callback_data:"BUY"}],
      [{text:"📣 Compartir",callback_data:"SHARE"}]
    ]
  };

  const s = state.get(chat) || {};
  if(!s.msg){
    const m = await photo(chat,it.imagen,caption,{reply_markup:kb});
    state.set(chat,{...s,list,index:i,msg:m.result.message_id});
  }else{
    await editMedia(chat,s.msg,it.imagen,caption,{reply_markup:kb});
    state.set(chat,{...s,index:i});
  }
}

/* ---------------- COMPARTIR ---------------- */
function shareProduct(chat){
  const s = state.get(chat);
  const it = s.list[s.index];
  const link = `https://t.me/${BOT_USERNAME}?start=P_${it.codigo}`;
  const txt = `🧀 Mirá esto:\n${it.nombre}\n$ ${it.precio}\n${link}`;

  const kb = {
    inline_keyboard:[
      [{text:"📣 WhatsApp",url:`https://wa.me/?text=${encodeURIComponent(txt)}`}],
      [{text:"✈️ Telegram",url:`https://t.me/share/url?url=${encodeURIComponent(link)}`}]
    ]
  };
  send(chat,txt,{reply_markup:kb});
}

/* ---------------- SELLITOS ---------------- */
function showStamps(chat){
  const n = stamps.get(chat)||0;
  send(chat,
`🏷️ <b>Tus sellos</b>

Tenés <b>${n}</b> sellos.
Cada $10.000 sumás 1 sello.

👉 Compartí promos o comprá para sumar más.`,
{reply_markup:mainMenu});
}

/* ---------------- AYUDA ---------------- */
async function help(chat){
  const cfg = await fetchData("config");
  send(chat,
`🆘 <b>Ayuda</b>

Si no encontraste algo en el catálogo o necesitás hacer una consulta especial,
podés escribirnos directamente 👇

📲 ${cfg.NegocioTelefono}

Estamos para ayudarte 😊`,
{reply_markup:mainMenu});
}

/* ---------------- HANDLERS ---------------- */
app.post("/",async(req,res)=>{
  res.sendStatus(200);
  const u=req.body;

  if(u.message){
    const chat=u.message.chat.id;
    const txt=u.message.text||"";

    if(txt==="/start") return start(chat);
    if(txt.startsWith("/start ")) return start(chat,txt.split(" ")[1]);
    if(txt==="🛍️ Catálogo") return showCategories(chat);
    if(txt==="🏷️ Sellos") return showStamps(chat);
    if(txt==="📣 Compartir bot") return shareProduct(chat);
    if(txt==="🆘 Ayuda") return help(chat);
  }

  if(u.callback_query){
    const chat=u.callback_query.message.chat.id;
    const data=u.callback_query.data;
    const s=state.get(chat);

    if(data.startsWith("CAT_")){
      const cat=await fetchData("catalog");
      const list=cat.items.filter(i=>i.categoria===data.replace("CAT_",""));
      state.set(chat,{list,index:0});
      return showProduct(chat,list,0);
    }
    if(data==="NEXT") return showProduct(chat,s.list,(s.index+1)%s.list.length);
    if(data==="PREV") return showProduct(chat,s.list,(s.index-1+s.list.length)%s.list.length);
    if(data==="SHARE") return shareProduct(chat);
  }
});

/* ---------------- BOOT ---------------- */
app.listen(PORT,async()=>{
  const me=await tg("getMe",{});
  BOT_USERNAME=me.result.username;
  console.log("BOT OK",BOT_USERNAME);
});

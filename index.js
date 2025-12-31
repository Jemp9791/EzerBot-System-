import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const DATA_API = process.env.DATA_API_URL;

const users = new Map();
const carts = new Map();

/* ================== HELPERS ================== */
const tg = (m, p) => fetch(`${API}/${m}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(p)
});

const esc = t => String(t||"").replace(/[<>]/g,"");

async function getConfig(){
  const r = await fetch(`${DATA_API}?type=config`);
  return await r.json();
}
async function getCatalog(){
  const r = await fetch(`${DATA_API}?type=catalog`);
  return await r.json();
}

/* ================== MENÚ ================== */
const mainMenu = {
  keyboard: [
    [{text:"🛍️ Catálogo"}],
    [{text:"🏷️ Sellos"}],
    [{text:"📣 Compartir bot"}],
    [{text:"🆘 Ayuda"}]
  ],
  resize_keyboard:true
};

/* ================== START ================== */
async function start(chatId, payload=""){
  const cfg = await getConfig();

  const text = `
👋 ¡Hola ${payload?.nombre||""}!
Bienvenido/a a *${cfg.NegocioNombre}* 🧀

📍 ${cfg.NegocioDireccion}
🕒 ${cfg.NegocioHorario}

${cfg.Descripcion}
`.replace("{NOMBRE}", payload?.nombre||"");

  if(cfg.LogoURL){
    await tg("sendPhoto",{
      chat_id:chatId,
      photo:cfg.LogoURL,
      caption:text,
      parse_mode:"Markdown",
      reply_markup:mainMenu
    });
  }else{
    await tg("sendMessage",{
      chat_id:chatId,
      text,
      parse_mode:"Markdown",
      reply_markup:mainMenu
    });
  }
}

/* ================== CATÁLOGO ================== */
async function showCategories(chatId){
  const cat = await getCatalog();
  const rows = [];
  for(const c of cat.categories){
    rows.push([{text:c,callback_data:`CAT_${c}`}]);
  }
  await tg("sendMessage",{
    chat_id:chatId,
    text:"🛍️ Elegí una categoría",
    reply_markup:{inline_keyboard:rows}
  });
}

async function showProduct(chatId, state){
  const item = state.items[state.index];
  const cfg = await getConfig();

  const caption = `
🧀 *${item.nombre}*
${cfg.CatalogoMostrarPrecios==="SI" ? `💰 ${cfg.Moneda} ${item.precio}` : ""}
${item.descripcion||""}
`;

  await tg("sendPhoto",{
    chat_id:chatId,
    photo:item.imagen,
    caption,
    parse_mode:"Markdown",
    reply_markup:{
      inline_keyboard:[
        [
          {text:"⬅️",callback_data:"PREV"},
          {text:"➡️",callback_data:"NEXT"}
        ],
        [{text:"🟢 Quiero este",callback_data:"BUY"}],
        [{text:"📣 Compartir",callback_data:"SHARE_PROD"}]
      ]
    }
  });
}

/* ================== CANTIDAD ================== */
function askQty(chatId,item){
  const text = item.unidad==="unidad"
    ? "¿Cuántas unidades querés?"
    : "¿Cuántos gramos querés? (ej: 200)";

  users.get(chatId).awaitQty = item;
  tg("sendMessage",{chat_id:chatId,text});
}

/* ================== SELL0S ================== */
async function showSellos(chatId){
  const cfg = await getConfig();
  const u = users.get(chatId)||{sellos:0};

  const total = u.sellos||0;
  const porNivel = cfg.SellosPorNivel.split("|").map(Number);
  const niveles = cfg.NombresNiveles.split("|");

  let nivel = niveles[0];
  for(let i=0;i<porNivel.length;i++){
    if(total>=porNivel[i]) nivel = niveles[i];
  }

  await tg("sendMessage",{
    chat_id:chatId,
    text:
`🏷️ *Tus sellos*
Tenés *${total}* sellos
Nivel: *${nivel}*

Cada $${cfg.MontoPorSello} sumás 1 sello.`,
    parse_mode:"Markdown",
    reply_markup:mainMenu
  });
}

/* ================== COMPARTIR BOT ================== */
async function shareBot(chatId){
  const cfg = await getConfig();
  const link = cfg.BotLink;
  const text = `
✨ ${cfg.TextoSistema}

📩 ${cfg.EmailSistema}
🤖 ${link}
`;

  await tg("sendMessage",{
    chat_id:chatId,
    text,
    reply_markup:{
      inline_keyboard:[
        [{text:"WhatsApp",url:`https://wa.me/?text=${encodeURIComponent(text)}`}],
        [{text:"Telegram",url:`https://t.me/share/url?url=${link}`}]
      ]
    }
  });
}

/* ================== AYUDA ================== */
async function help(chatId){
  const cfg = await getConfig();
  await tg("sendMessage",{
    chat_id:chatId,
    text:
`🆘 *¿Necesitás ayuda?*

Si no encontraste algo en el catálogo,
o querés hacer una consulta especial,
podés acercarte a nuestro local o escribirnos.

📍 ${cfg.NegocioDireccion}
🕒 ${cfg.NegocioHorario}
📲 ${cfg.WhatsAppLink}`,
    parse_mode:"Markdown",
    reply_markup:mainMenu
  });
}

/* ================== WEBHOOK ================== */
app.post("/",async(req,res)=>{
  res.sendStatus(200);
  const u=req.body;
  if(!u.message && !u.callback_query) return;

  const msg = u.message;
  const cb = u.callback_query;
  const chatId = msg?.chat.id || cb?.message.chat.id;

  users.set(chatId,users.get(chatId)||{sellos:0});

  if(msg?.text){
    if(msg.text==="/start") return start(chatId);
    if(msg.text==="🛍️ Catálogo") return showCategories(chatId);
    if(msg.text==="🏷️ Sellos") return showSellos(chatId);
    if(msg.text==="📣 Compartir bot") return shareBot(chatId);
    if(msg.text==="🆘 Ayuda") return help(chatId);
  }

  if(cb){
    const state = users.get(chatId);
    if(cb.data.startsWith("CAT_")){
      const cat = await getCatalog();
      state.items = cat.items.filter(i=>i.categoria===cb.data.replace("CAT_",""));
      state.index = 0;
      return showProduct(chatId,state);
    }
    if(cb.data==="NEXT"){ state.index++; return showProduct(chatId,state);}
    if(cb.data==="PREV"){ state.index--; return showProduct(chatId,state);}
    if(cb.data==="BUY"){ return askQty(chatId,state.items[state.index]);}
  }
});

/* ================== START SERVER ================== */
app.listen(PORT,()=>console.log("BOT LISTO"));

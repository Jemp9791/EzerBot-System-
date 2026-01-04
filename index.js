import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL.replace(/\/$/, "");
const DATA_API_URL = process.env.DATA_API_URL.replace(/\/$/, "");

const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

const users = new Map(); // estado
const carts = new Map(); // carrito
const orders = new Map(); // pedido

/* -------------------- UTIL -------------------- */
const esc = (s="") => String(s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const money = (n,c) => `${c} ${Number(n).toLocaleString("es-AR")}`;
const lower = (s="") => s.toLowerCase();
const isHttp = (u) => /^https?:\/\//i.test(u||"");

/* -------------------- DATA -------------------- */
let CACHE = { cfg:null, cat:null, t:0 };

async function loadData(){
  if (Date.now()-CACHE.t < 15000) return CACHE;
  const cfg = await fetch(`${DATA_API_URL}?type=config`).then(r=>r.json());
  const cat = await fetch(`${DATA_API_URL}?type=catalog`).then(r=>r.json());
  CACHE = { cfg, cat, t:Date.now() };
  return CACHE;
}

/* -------------------- TELEGRAM -------------------- */
const tg = (m,p)=>fetch(TG(m),{method:"POST",headers:{'content-type':'application/json'},body:JSON.stringify(p)}).then(r=>r.json());

/* -------------------- START -------------------- */
async function start(chat, payload){
  const {cfg} = await loadData();
  const estado = lower(cfg.Estado||"");
  let estadoTxt = "";
  if(estado.includes("abier")) estadoTxt="🟢 Abierto";
  if(estado.includes("cerr")) estadoTxt="🔴 Cerrado";
  if(estado.includes("vac")) estadoTxt="🏖️ Vacaciones";

  const msg = 
`👋 *${cfg.NegocioNombre}*  
${estadoTxt}

📍 ${cfg.NegocioDireccion}
🕒 ${cfg.NegocioHorario}
📲 ${cfg.NegocioTelefono}

${cfg.Descripcion}`;

  const kb = {
    inline_keyboard:[
      [{text:"🛍️ Catálogo",callback_data:"CAT"}],
      [{text:"🏷️ Sellos",callback_data:"SELL"}],
      [{text:"📣 Compartir bot",callback_data:"SHAREBOT"}],
      [{text:"🆘 Ayuda",callback_data:"HELP"}]
    ]
  };

  if(isHttp(cfg.LogoURL))
    return tg("sendPhoto",{chat_id:chat,photo:cfg.LogoURL,caption:msg,parse_mode:"Markdown",reply_markup:kb});
  return tg("sendMessage",{chat_id:chat,text:msg,parse_mode:"Markdown",reply_markup:kb});
}

/* -------------------- CATÁLOGO -------------------- */
async function showProduct(chat, list, i){
  const {cfg} = await loadData();
  const it = list[i];
  users.set(chat,{list,i});

  const price = cfg.CatalogoMostrarPrecios==="SI" ? `💰 ${money(it.precio,cfg.Moneda)} (${it.unidad})\n`:"";

  const cap =
`🧀 *${it.nombre}*
${price}${it.descripcion}

_${i+1} de ${list.length}_`;

  const kb={
    inline_keyboard:[
      [{text:"⬅️",callback_data:"PREV"},{text:"➡️",callback_data:"NEXT"}],
      [{text:"🟢 Quiero esta promo",callback_data:"BUY"}],
      [{text:"📣 Compartir promo",callback_data:"SHAREPROD"}],
      [{text:"🏠 Menú",callback_data:"HOME"}]
    ]
  };

  return tg("sendPhoto",{chat_id:chat,photo:it.imagen,caption:cap,parse_mode:"Markdown",reply_markup:kb});
}

/* -------------------- COMPRA -------------------- */
function isPesable(p){
  return lower(p.unidad)==="kg" || Number(p.precioPorKilo||0)>0;
}

async function askQty(chat){
  const st = users.get(chat);
  const p = st.list[st.i];
  st.askQty=true;
  const txt = isPesable(p)
    ? "¿Cuántos *gramos* querés? (ej: 200)"
    : "¿Cuántas *unidades* querés? (ej: 1)";
  return tg("sendMessage",{chat_id:chat,text:txt,parse_mode:"Markdown"});
}

async function addCart(chat, qty){
  const {cfg} = await loadData();
  const st = users.get(chat);
  const p = st.list[st.i];
  const cart = carts.get(chat)||[];
  let subtotal = isPesable(p)
    ? (qty/1000)*p.precio
    : qty*p.precio;

  cart.push({nombre:p.nombre,qty,subtotal});
  carts.set(chat,cart);
  st.askQty=false;

  return tg("sendMessage",{chat_id:chat,text:`✅ Agregado. Total parcial: *${money(cart.reduce((a,b)=>a+b.subtotal,0),cfg.Moneda)}*`,parse_mode:"Markdown",
    reply_markup:{inline_keyboard:[
      [{text:"🛒 Finalizar compra",callback_data:"CHECKOUT"}],
      [{text:"🛍️ Seguir comprando",callback_data:"CAT"}]
    ]}
  });
}

/* -------------------- CHECKOUT -------------------- */
async function checkout(chat){
  const {cfg} = await loadData();
  return tg("sendMessage",{chat_id:chat,text:"¿Cómo querés recibir tu pedido?",
    reply_markup:{inline_keyboard:[
      [{text:"🏠 Retiro",callback_data:"RETIRO"}],
      [{text:`🚚 Envío (+${money(cfg.CostoEnvio,cfg.Moneda)})`,callback_data:"ENVIO"}]
    ]}
  });
}

/* -------------------- HELP -------------------- */
async function help(chat){
  const {cfg}=await loadData();
  const txt =
`🆘 *¿Te ayudamos?*

• ¿No encontraste algo en el catálogo?
• ¿Querés sugerir un producto?
• ¿Tenés una consulta o comentario?

📲 Escribinos y te respondemos enseguida.`;
  return tg("sendMessage",{chat_id:chat,text:txt,parse_mode:"Markdown"});
}

/* -------------------- SHARE -------------------- */
async function shareBot(chat){
  const {cfg}=await loadData();
  const txt = `${cfg.TextoSistema}\n${cfg.BotLink}\n📩 ${cfg.EmailSistema}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(txt)}`;
  return tg("sendMessage",{chat_id:chat,text:txt,
    reply_markup:{inline_keyboard:[
      [{text:"📣 WhatsApp",url:wa}],
      [{text:"✈️ Telegram",url:`https://t.me/share/url?url=${encodeURIComponent(cfg.BotLink)}`}]
    ]}
  });
}

/* -------------------- CALLBACK -------------------- */
app.post("/",async(req,res)=>{
  res.sendStatus(200);
  const u=req.body;
  if(u.message){
    const c=u.message.chat.id;
    const st=users.get(c)||{};
    if(st.askQty){
      return addCart(c,Number(u.message.text));
    }
    if(u.message.text==="/start") return start(c);
  }
  if(u.callback_query){
    const c=u.callback_query.message.chat.id;
    const d=u.callback_query.data;
    if(d==="HOME") return start(c);
    if(d==="HELP") return help(c);
    if(d==="SHAREBOT") return shareBot(c);
    if(d==="CAT"){
      const {cat}=await loadData();
      return showProduct(c,cat.items,0);
    }
    if(d==="NEXT"||d==="PREV"){
      const st=users.get(c);
      st.i = d==="NEXT"?(st.i+1)%st.list.length:(st.i-1+st.list.length)%st.list.length;
      return showProduct(c,st.list,st.i);
    }
    if(d==="BUY") return askQty(c);
    if(d==="CHECKOUT") return checkout(c);
  }
});

/* -------------------- BOOT -------------------- */
app.listen(PORT,()=>console.log("BOT OK"));

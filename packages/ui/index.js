import { PROVIDER_CATALOG as PROVIDERS, installationCommand as installation } from "@edukors/ai-cli/settings";
import { createElement as h, useEffect, useRef, useState } from "react";
const words = {};
const entries = {
  title: ["Assistente de IA", "AI assistant", "Asistente de IA"],
  accounts: ["Contas", "Accounts", "Cuentas"],
  shared: ["Suas contas ficam dispon\xEDveis nos apps EDUKORS deste computador. Cada aplicativo pode usar uma conta padr\xE3o diferente.", "Your accounts are available in EDUKORS apps on this computer. Each app can use a different default account.", "Tus cuentas est\xE1n disponibles en las apps EDUKORS de este equipo. Cada aplicaci\xF3n puede usar una cuenta predeterminada diferente."],
  defaultAccount: ["Conta padr\xE3o neste aplicativo", "Default account in this app", "Cuenta predeterminada en esta aplicaci\xF3n"],
  choose: ["Escolha uma conta", "Choose an account", "Elige una cuenta"],
  add: ["Adicionar conta", "Add account", "A\xF1adir cuenta"],
  name: ["Nome da conta", "Account name", "Nombre de la cuenta"],
  provider: ["Servi\xE7o de IA", "AI service", "Servicio de IA"],
  connected: ["Conectada", "Signed in", "Conectada"],
  disconnected: ["Desconectada", "Signed out", "Desconectada"],
  expired: ["Entre novamente", "Sign in again", "Inicia sesi\xF3n de nuevo"],
  unknown: ["N\xE3o foi poss\xEDvel verificar", "Could not be checked", "No se pudo verificar"],
  checking: ["Verificando\u2026", "Checking\u2026", "Verificando\u2026"],
  login: ["Entrar na conta", "Sign in", "Iniciar sesi\xF3n"],
  logout: ["Sair da conta", "Sign out", "Cerrar sesi\xF3n"],
  remove: ["Remover conta", "Remove account", "Eliminar cuenta"],
  cancel: ["Cancelar", "Cancel", "Cancelar"],
  rename: ["Renomear", "Rename", "Cambiar nombre"],
  removeConfirm: ["Remover esta conta de todos os apps EDUKORS deste computador? Os documentos e hist\xF3ricos ser\xE3o preservados.", "Remove this account from all EDUKORS apps on this computer? Documents and conversation histories will be kept.", "\xBFEliminar esta cuenta de todas las apps EDUKORS de este equipo? Los documentos e historiales se conservar\xE1n."],
  waiting: ["Conclua a entrada no navegador.", "Complete sign-in in your browser.", "Completa el inicio de sesi\xF3n en el navegador."],
  openBrowser: ["Abrir navegador", "Open browser", "Abrir navegador"],
  copyLink: ["Copiar endere\xE7o", "Copy address", "Copiar enlace"],
  code: ["C\xF3digo de autoriza\xE7\xE3o", "Authorization code", "C\xF3digo de autorizaci\xF3n"],
  codeHelp: ["Cole o c\xF3digo mostrado depois de autorizar o acesso; n\xE3o \xE9 o c\xF3digo de verifica\xE7\xE3o recebido por e-mail.", "Paste the code shown after authorizing access, not the verification code sent by email.", "Pega el c\xF3digo mostrado despu\xE9s de autorizar el acceso, no el c\xF3digo de verificaci\xF3n enviado por correo."],
  submit: ["Enviar c\xF3digo", "Send code", "Enviar c\xF3digo"],
  guide: ["Abrir guia oficial", "Open official guide", "Abrir gu\xEDa oficial"],
  verify: ["Verificar instala\xE7\xE3o", "Check installation", "Verificar instalaci\xF3n"],
  copied: ["Copiado", "Copied", "Copiado"],
  copyCommand: ["Copiar comando", "Copy command", "Copiar comando"],
  missing: ["O componente de conex\xE3o n\xE3o foi encontrado. Ter o aplicativo desktop n\xE3o garante que a CLI esteja dispon\xEDvel.", "The connection component was not found. Having the desktop app does not guarantee the CLI is available.", "No se encontr\xF3 el componente de conexi\xF3n. Tener la aplicaci\xF3n de escritorio no garantiza que la CLI est\xE9 disponible."],
  incompatible: ["Esta vers\xE3o precisa ser atualizada para funcionar com o EDUKORS.", "This version needs to be updated to work with EDUKORS.", "Esta versi\xF3n debe actualizarse para funcionar con EDUKORS."],
  error: ["N\xE3o foi poss\xEDvel verificar a instala\xE7\xE3o. Tente novamente.", "The installation could not be checked. Try again.", "No se pudo verificar la instalaci\xF3n. Int\xE9ntalo de nuevo."],
  unsupported: ["Este servi\xE7o n\xE3o est\xE1 dispon\xEDvel neste aplicativo e sistema.", "This service is not available in this app on this system.", "Este servicio no est\xE1 disponible en esta aplicaci\xF3n y sistema."],
  mac: ["Abra a busca do Mac com \u2318 Espa\xE7o, digite Terminal e abra o aplicativo.", "Open Mac search with \u2318 Space, type Terminal and open the app.", "Abre la b\xFAsqueda del Mac con \u2318 Espacio, escribe Terminal y abre la aplicaci\xF3n."],
  windows: ["Abra o menu Iniciar, procure Windows PowerShell e abra o aplicativo.", "Open Start, search for Windows PowerShell and open it.", "Abre Inicio, busca Windows PowerShell y \xE1brelo."],
  linux: ["Abra o aplicativo Terminal da sua distribui\xE7\xE3o.", "Open your distribution\u2019s Terminal app.", "Abre la aplicaci\xF3n Terminal de tu distribuci\xF3n."],
  paste: ["Copie o comando, cole no terminal e pressione Enter. Aguarde terminar e volte aqui para verificar a instala\xE7\xE3o.", "Copy the command, paste it into the terminal and press Enter. Wait for it to finish, then return here to check the installation.", "Copia el comando, p\xE9galo en el terminal y pulsa Enter. Espera a que termine y vuelve aqu\xED para verificar la instalaci\xF3n."],
  notFound: ["Se ainda n\xE3o encontrar, feche e abra novamente o EDUKORS e tente verificar outra vez.", "If it is still not found, close and reopen EDUKORS and check again.", "Si a\xFAn no se encuentra, cierra y vuelve a abrir EDUKORS y verifica de nuevo."],
  advanced: ["Avan\xE7ado", "Advanced", "Avanzado"],
  instructions: ["Instru\xE7\xF5es para o assistente", "Instructions for the assistant", "Instrucciones para el asistente"],
  mcp: ["Servidores MCP", "MCP servers", "Servidores MCP"],
  skills: ["Skills", "Skills", "Skills"],
  save: ["Salvar altera\xE7\xF5es", "Save changes", "Guardar cambios"],
  discard: ["Descartar", "Discard", "Descartar"],
  dirty: ["H\xE1 altera\xE7\xF5es n\xE3o salvas. Salvar antes de sair?", "There are unsaved changes. Save before leaving?", "Hay cambios sin guardar. \xBFGuardar antes de salir?"],
  account: ["Conta", "Account", "Cuenta"],
  model: ["Modelo", "Model", "Modelo"],
  defaultModel: ["Padr\xE3o da conta", "Account default", "Predeterminado de la cuenta"],
  effort: ["Esfor\xE7o", "Effort", "Esfuerzo"],
  defaultEffort: ["Padr\xE3o", "Default", "Predeterminado"],
  custom: ["Outro modelo (ID)", "Other model (ID)", "Otro modelo (ID)"],
  usage: ["Uso da conta", "Account usage", "Uso de la cuenta"],
  noUsage: ["Uso ainda n\xE3o informado", "Usage not yet reported", "Uso a\xFAn no informado"],
  eventUsage: ["O servi\xE7o atualiza esta informa\xE7\xE3o durante as conversas.", "The service updates this information during conversations.", "El servicio actualiza esta informaci\xF3n durante las conversaciones."],
  details: ["Ver detalhes", "View details", "Ver detalles"],
  refresh: ["Atualizar", "Refresh", "Actualizar"],
  old: ["Informa\xE7\xE3o antiga", "Older information", "Informaci\xF3n antigua"],
  resets: ["renova", "resets", "se renueva"],
  observed: ["Atualizado", "Updated", "Actualizado"],
  five_hour: ["5 horas", "5 hours", "5 horas"],
  seven_day: ["Semanal", "Weekly", "Semanal"],
  history: ["Conversas", "Conversations", "Conversaciones"],
  newChat: ["Nova conversa", "New conversation", "Nueva conversaci\xF3n"],
  close: ["Fechar", "Close", "Cerrar"],
  search: ["Buscar conversas", "Search conversations", "Buscar conversaciones"],
  empty: ["Nenhuma conversa", "No conversations", "Ninguna conversaci\xF3n"],
  today: ["Hoje", "Today", "Hoy"],
  yesterday: ["Ontem", "Yesterday", "Ayer"],
  earlier: ["Anteriores", "Earlier", "Anteriores"],
  switchHint: ["Trocar de conta inicia outra conversa. A atual ficar\xE1 no hist\xF3rico.", "Switching accounts starts another conversation. The current one stays in history.", "Cambiar de cuenta inicia otra conversaci\xF3n. La actual queda en el historial."],
  mode: ["Modo", "Mode", "Modo"],
  ask: ["Revisar antes de aplicar", "Review before applying", "Revisar antes de aplicar"],
  auto: ["Aplicar altera\xE7\xF5es", "Apply changes", "Aplicar cambios"],
  plan: ["Planejar", "Plan", "Planificar"],
  preparing: ["Preparando", "Preparing", "Preparando"],
  thinking: ["Pensando", "Thinking", "Pensando"],
  reading: ["Lendo", "Reading", "Leyendo"],
  researching: ["Pesquisando", "Researching", "Investigando"],
  applying: ["Aplicando", "Applying", "Aplicando"],
  freeAnswer: ["Ou escreva sua resposta", "Or write your answer", "O escribe tu respuesta"],
  answer: ["Enviar resposta", "Send answer", "Enviar respuesta"],
  answered: ["Respondida", "Answered", "Respondida"],
  approve: ["Aprovar", "Approve", "Aprobar"],
  deny: ["Recusar", "Decline", "Rechazar"]
};
Object.assign(entries,{"askShort": ["Revisar antes", "Ask first", "Revisar antes"], "autoShort": ["Aplicar", "Apply", "Aplicar"], "planShort": ["Planejar", "Plan", "Planificar"], "askHint": ["Cada alteração espera sua aprovação.", "Each change waits for your approval.", "Cada cambio espera tu aprobación."], "autoHint": ["Aplica alterações permitidas, com Desfazer.", "Applies permitted changes, with Undo available.", "Aplica cambios permitidos, con Deshacer disponible."], "planHint": ["Prepara um plano sem alterar o documento.", "Prepares a plan without changing the document.", "Prepara un plan sin cambiar el documento."], "effort_minimal": ["Mínimo", "Minimal", "Mínimo"], "effort_low": ["Baixo", "Low", "Bajo"], "effort_medium": ["Médio", "Medium", "Medio"], "effort_high": ["Alto", "High", "Alto"], "effort_xhigh": ["Muito alto", "Very high", "Muy alto"], "effort_max": ["Máximo", "Max", "Máximo"], "effort_ultra": ["Máximo", "Max", "Máximo"]});
for (const [i, lang] of ["pt", "en", "es"].entries()) words[lang] = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v[i]]));
const uiText = (lang, key) => words[lang]?.[key] ?? words.en[key] ?? key;
import { PROVIDER_CATALOG, installationCommand } from "@edukors/ai-cli/settings";
function normalizeOptions(models, model = "default", effort = "auto") {
  const id = model || "default", info = models.find((m) => m.id === id), levels = info?.efforts ?? [];
  return { model: id, effort: levels.includes(effort) ? effort : "auto", levels };
}
const button = (text, onClick, props = {}) => h("button", { type: "button", onClick, ...props }, text);
function ProviderSetup({ lang = "en", provider, status = "missing", platform: initialPlatform, onOpen, onVerify }) {
  const [platform, setPlatform] = useState(initialPlatform ?? (/Win/i.test(globalThis.navigator?.platform ?? "") ? "windows" : /Linux/i.test(globalThis.navigator?.platform ?? "") ? "linux" : "mac"));
  const [busy, setBusy] = useState(false), [copied, setCopied] = useState(false), [error, setError] = useState("");
  const t = (k) => uiText(lang, k), p = PROVIDERS.find((p2) => p2.id === provider);
  if (!p || status === "ready") return null;
  return h("section", { className: "eai eai-setup" }, h("strong", null, p.cli), h("p", { role: "status" }, t(status)), status !== "unsupported" && h(
    "div",
    null,
    h("label", null, "", h("select", { "aria-label": "Operating system", value: platform, onChange: (e) => setPlatform(e.target.value) }, ...["mac", "windows", "linux"].map((v) => h("option", { key: v, value: v }, v === "mac" ? "macOS" : v === "windows" ? "Windows" : "Linux")))),
    h("ol", null, h("li", null, t(platform)), h("li", null, t("paste"))),
    h("code", { className: "eai-command" }, installation(provider, platform)),
    h("div", { className: "eai-actions" }, button(t(copied ? "copied" : "copyCommand"), async () => {
      try {
        await navigator.clipboard.writeText(installation(provider, platform));
        setCopied(true);
      } catch (e) {
        setError(String(e));
      }
    }), h("a", { href: p.url, onClick: (e) => {
      e.preventDefault();
      onOpen(p.url);
    } }, t("guide")), button(t(busy ? "checking" : "verify"), async () => {
      setBusy(true);
      setError("");
      try {
        await onVerify();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    }, { disabled: busy })),
    h("small", null, t("notFound"))
  ), error && h("p", { role: "alert" }, error));
}
function SignIn({ lang = "en", login, onOpen, onCode, onCancel }) {
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const t = (k) => uiText(lang, k);
  return h("div", { className: "eai eai-login" }, h("p", { role: "status" }, t("waiting")), login.url && h("div", { className: "eai-actions" }, button(t("openBrowser"), () => onOpen(login.url)), button(t("copyLink"), async () => {
    try {
      await navigator.clipboard.writeText(login.url);
    } catch (e) {
      setError(String(e));
    }
  })), login.acceptsCode && h("form", { onSubmit: async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onCode(code.trim());
    } catch (e2) {
      setError(String(e2));
    } finally {
      setBusy(false);
    }
  } }, h("label", null, t("code"), h("input", { value: code, autoComplete: "off", spellCheck: false, onChange: (e) => setCode(e.target.value) })), h("small", null, t("codeHelp")), h("button", { type: "submit", disabled: busy || !code.trim() }, t("submit"))), error && h("p", { role: "alert" }, error), button(t("cancel"), onCancel));
}
function AccountPicker({ lang = "en", accounts, value, onChange, disabled = false, defaultPicker = false, onManage }) {
  const t = (k) => uiText(lang, k);
  return h("div", { className: "eai eai-account-picker", title: defaultPicker ? "" : t("switchHint") }, h("span", null, t(defaultPicker ? "defaultAccount" : "account")), h("select", { value: value ?? "", disabled, "aria-label": t(defaultPicker ? "defaultAccount" : "account"), onChange: (e) => onChange(e.target.value) }, h("option", { value: "", disabled: !defaultPicker }, t("choose")), ...accounts.map((a) => h("option", { key: a.id, value: a.id, disabled: a.supported === false }, `${a.label} \xB7 ${a.providerId === "claude" ? "Claude" : "Codex"}${a.supported === false ? " \u2014 " + t("unsupported") : ""}`))), onManage && button(t("accounts"), onManage));
}
function AssistantAccounts({ lang = "en", accounts, providers, value, onSelect, onCreate, onConnect, onLogout, onRename, onRemove, onVerify, onStatus, onOpen, login, onCode, onCancel, busy: externalBusy = false }) {
  const [adding, setAdding] = useState(false), [provider, setProvider] = useState(providers.some((p) => p.id === "claude") ? "claude" : providers[0]?.id || "claude"), [name, setName] = useState(""), [busy, setBusy] = useState(""), [error, setError] = useState(""), [states, setStates] = useState({});
  const t = (k) => uiText(lang, k);
  const run = async (id, fn) => {
    setBusy(id);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    let alive = true;
    for (const a of accounts) if (onStatus) onStatus(a.id).then((s) => {
      if (alive) setStates((old) => ({ ...old, [a.id]: s }));
    }, () => {
      if (alive) setStates((old) => ({ ...old, [a.id]: { state: "unknown" } }));
    });
    return () => {
      alive = false;
    };
  }, [accounts, onStatus]);
  const catalog = providers.map((p) => ({ ...PROVIDERS.find((c) => c.id === p.id), ...p, name: p.name || PROVIDERS.find((c) => c.id === p.id)?.name || p.id }));
  const chosen = providers.find((p) => p.id === provider), disabled = !!busy || externalBusy;
  return h(
    "section",
    { className: "eai eai-accounts" },
    h("h2", null, t("accounts")),
    h("p", null, t("shared")),
    h(AccountPicker, { lang, accounts, value, onChange: onSelect, disabled, defaultPicker: true }),
    ...accounts.map((a) => {
      const p = providers.find((p2) => p2.id === a.providerId), state = a.status ?? states[a.id], activeLogin = login?.accountId === a.id;
      return h(
        "details",
        { key: a.id, className: "eai-account", ...activeLogin ? { open: true } : {} },
        h("summary", null, h("span", null, h("strong", null, a.label), h("small", null, `${a.providerId === "claude" ? "Claude" : "Codex"}${state?.identity ? " \xB7 " + state.identity : ""}`)), h("span", { className: "eai-badge" }, t(a.supported === false ? "unsupported" : p?.status && p.status !== "ready" ? p.status : state?.state ?? "checking")), a.id === value && h("span", { className: "eai-badge" }, t("defaultAccount"))),
        a.supported === false ? h("p", null, t("unsupported")) : p?.status && p.status !== "ready" ? h(ProviderSetup, { lang, provider: a.providerId, status: p.status, onOpen, onVerify }) : activeLogin ? h(SignIn, { lang, login, onOpen, onCode, onCancel }) : h("div", null, h("label", null, t("name"), h("input", { defaultValue: a.label, key: a.label, maxLength: 80, disabled, onBlur: (e) => {
          const label = e.target.value.trim();
          if (label && label !== a.label) void run(a.id, () => onRename(a.id, label));
        } })), h("div", { className: "eai-actions" }, button(t(state?.state === "connected" ? "expired" : "login"), () => run(a.id, () => onConnect(a.id)), { disabled }), state?.state === "connected" && button(t("logout"), () => run(a.id, () => onLogout(a.id)), { disabled }))),
        button(t("remove"), () => run(a.id, () => onRemove(a.id, t("removeConfirm"))), { disabled, className: "eai-danger" })
      );
    }),
    adding ? h(
      "div",
      { className: "eai-add" },
      h("h3", null, t("add")),
      h("div", { className: "eai-actions", role: "radiogroup", "aria-label": t("provider") }, ...catalog.map((p) => button(p.name, () => {
        setProvider(p.id);
        setName(p.name.split(" \u2014")[0]);
      }, { key: p.id, role: "radio", "aria-checked": provider === p.id }))),
      chosen?.supported === false ? h("p", null, t("unsupported")) : chosen?.status !== "ready" ? h(ProviderSetup, { lang, provider, status: chosen?.status ?? "missing", onOpen, onVerify }) : h("form", { onSubmit: (e) => {
        e.preventDefault();
        void run("create", async () => {
          const id = await onCreate(provider, name.trim() || (catalog.find((p) => p.id === provider)?.name || provider).split(" \u2014")[0]);
          setAdding(false);
          await onConnect(id);
        });
      } }, h("label", null, t("name"), h("input", { value: name, maxLength: 80, onChange: (e) => setName(e.target.value) })), h("button", { type: "submit", disabled }, t("login"))),
      button(t("cancel"), () => setAdding(false), { disabled })
    ) : button(t("add"), () => setAdding(true), { disabled }),
    error && h("p", { role: "alert", className: "eai-error" }, error)
  );
}
function AdvancedSettings({ lang = "en", children, dirty = false, error, onSave, onDiscard }) {
  const t = (k) => uiText(lang, k);
  return h("details", { className: "eai eai-advanced" }, h("summary", null, t("advanced")), children, onSave && h("div", { className: "eai-actions" }, button(t("save"), onSave, { disabled: !dirty || !!error }), button(t("discard"), onDiscard, { disabled: !dirty })), error && h("p", { role: "alert" }, error));
}
/** A compact chip and a viewport-clamped menu anchored above the composer. */
function MenuIcon({name,size=14}) {
  const paths={ask:['M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V14','M8 13a1.5 1.5 0 0 0-3 0v1a7 7 0 0 0 7 7h1a5 5 0 0 0 5-5v-4.5a1.5 1.5 0 0 0-3 0'],auto:['M13 2.5 4.5 13.5H12L11 21.5l8.5-11H12z'],plan:['M5 4h14v17H5z','M9 4V3h6v1M9 10h6M9 14h6M9 18h3'],chevron:['m6 9 6 6 6-6'],check:['m5 12.5 4.5 4.5L19 7.5']};
  return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,className:'eai-icon'},...(paths[name]||paths.chevron).map((d,i)=>h('path',{key:i,d})));
}
function UpwardMenu({label,chip,disabled=false,kind='model',children}) {
  const [open,setOpen]=useState(false),[position,setPosition]=useState({}),wrap=useRef(null),trigger=useRef(null),panel=useRef(null),id=useRef(`eai-menu-${Math.random().toString(36).slice(2)}`);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  const show=()=>{
    if(disabled)return;
    if(open){close();return;}
    const rect=trigger.current.getBoundingClientRect(),width=Math.min(300,window.innerWidth-24);
    setPosition({position:'fixed',left:Math.max(12,Math.min(rect.right-width,window.innerWidth-width-12)),right:'auto',bottom:window.innerHeight-rect.top+6,top:'auto',width,maxHeight:Math.max(0,Math.min(480,rect.top-12))});
    window.dispatchEvent(new CustomEvent('edukors-ai-menu-open',{detail:id.current}));
    setOpen(true);
  };
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  useEffect(()=>{
    if(!open)return;
    const away=e=>{if(!wrap.current?.contains(e.target))setOpen(false);},resize=()=>setOpen(false),other=e=>{if(e.detail!==id.current)setOpen(false);};
    const keys=e=>{
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();return;}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key)||e.target?.getAttribute('role')!=='menuitemradio')return;
      const items=[...panel.current.querySelectorAll('[role="menuitemradio"]')].filter(el=>!el.disabled),at=items.indexOf(document.activeElement);
      const next=e.key==='Home'?0:e.key==='End'?items.length-1:(at+(e.key==='ArrowUp'?-1:1)+items.length)%items.length;
      e.preventDefault();items[next]?.focus();
    };
    panel.current?.querySelector('[role="menuitemradio"][aria-checked="true"], [role="menuitemradio"]')?.focus();
    document.addEventListener('pointerdown',away);document.addEventListener('keydown',keys);window.addEventListener('resize',resize);window.addEventListener('edukors-ai-menu-open',other);
    return()=>{document.removeEventListener('pointerdown',away);document.removeEventListener('keydown',keys);window.removeEventListener('resize',resize);window.removeEventListener('edukors-ai-menu-open',other);};
  },[open]);
  return h('div',{className:`eai eai-pop eai-${kind}`,ref:wrap},button(h('span',{className:'eai-chip-content'},chip,h(MenuIcon,{name:'chevron',size:12})),show,{ref:trigger,className:`eai-chip${open?' is-open':''}`,disabled,title:label,'aria-label':label,'aria-expanded':open,'aria-haspopup':kind==='mode'?'menu':'dialog','aria-controls':open?id.current:undefined,onKeyDown:e=>{if(!open&&(e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();show();}}}),open&&h('div',{className:`eai-up-menu eai-${kind}-pop`,ref:panel,style:position,role:kind==='mode'?'menu':'dialog',id:id.current,'aria-label':label},children(close)));
}
export function effortStops(levels=[]) {return ['auto',...new Set(levels.filter(level=>level&&level!=='auto'&&level!=='default'))];}
function effortName(lang,level){return uiText(lang,level==='auto'?'defaultEffort':`effort_${level}`).replace(/^effort_/, '');}
export function EffortSlider({lang,levels,effort,onChange}) {
  const stops=effortStops(levels),at=Math.max(0,stops.indexOf(effort)),last=stops.length-1,name=effortName(lang,stops[at]);
  return h('section',{className:'eai-effort'},h('div',{className:'eai-effort-head'},h('span',{className:'eai-menu-label'},uiText(lang,'effort')),h('span',{className:'eai-effort-value'},name)),h('input',{type:'range',className:'eai-effort-range',min:0,max:last,step:1,value:at,'aria-label':uiText(lang,'effort'),'aria-valuetext':name,style:{'--fill':`${last?at/last*100:0}%`},onChange:e=>onChange(stops[Number(e.target.value)])}),h('div',{className:'eai-effort-ticks','aria-hidden':true},...stops.map((level,i)=>h('span',{key:level,className:i<=at?'is-on':''}))),h('div',{className:'eai-effort-ends','aria-hidden':true},h('span',null,effortName(lang,'auto')),h('span',null,effortName(lang,stops[last]))));
}
function ModelOptions({lang='en',models,value='default',effort='auto',disabled=false,onModel,onEffort,loading=false,error=false,onRetry}) {
  const t=k=>uiText(lang,k),options=normalizeOptions(models,value,effort),label=id=>models.find(m=>m.id===id)?.label||(id==='default'?t('defaultModel'):id);
  const choices=[{id:'default'},...models.filter(m=>m.id!=='default'),...(value&&value!=='default'&&!models.some(m=>m.id===value)?[{id:value}]:[])];
  const choose=id=>{onModel(id);if(!models.find(m=>m.id===id)?.efforts?.includes(effort))onEffort('auto');};
  return h(UpwardMenu,{kind:'model',label:`${t('model')}: ${label(value)}`,disabled,chip:h('span',{className:'eai-chip-text'},label(value),options.effort!=='auto'&&h('span',{className:'eai-chip-sub'},' · '+effortName(lang,options.effort)))},()=>h('div',null,h('div',{className:'eai-menu-label'},t('model')),loading&&h('p',{role:'status',className:'eai-menu-pad'},t('checking')),error&&h('div',{role:'alert',className:'eai-menu-pad'},t('unknown'),onRetry&&button(t('refresh'),onRetry)),h('div',{className:'eai-menu-list',role:'menu','aria-label':t('model')},...choices.map(m=>button(h('span',{className:'eai-menu-row'},h('span',{className:'eai-menu-text'},label(m.id)),m.id===(value||'default')&&h(MenuIcon,{name:'check'})),()=>choose(m.id),{key:m.id,role:'menuitemradio','aria-checked':m.id===(value||'default'),className:`eai-menu-item${m.id===(value||'default')?' is-on':''}`}))),options.levels.length>0&&h(EffortSlider,{lang,levels:options.levels,effort:options.effort,onChange:onEffort}),h('details',{className:'eai-model-advanced'},h('summary',null,t('advanced')),h('label',null,t('custom'),h('input',{key:value,defaultValue:value==='default'?'':value,onBlur:e=>{const id=e.target.value.trim()||'default';if(id!==value)choose(id);}})))));
}
function UsageSummary({ lang = "en", usage, onRefresh, loading = false, error = false }) {
  const t = (k) => uiText(lang, k), windows = (usage?.windows ?? []).filter((w) => Number.isFinite(w.used)), top = windows.reduce((a, b) => !a || b.used > a.used ? b : a, null), pct = (w) => `${Math.round(Math.min(1, Math.max(0, w.used)) * 100)}%`, date = (at) => new Date(at).toLocaleString(lang, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), old = top?.resetsAt && Date.parse(top.resetsAt) <= Date.now();
  return h("details", { className: "eai eai-usage" }, h("summary", null, top ? `${t("usage")}: ${pct(top)} \xB7 ${t(top.name)}${old ? " \xB7 " + t("old") : ""}` : t("noUsage")), windows.map((w) => h("div", { key: w.name, className: "eai-window" }, h("span", null, `${t(w.name)}: ${pct(w)}`), h("meter", { min: 0, max: 1, value: Math.min(1, Math.max(0, w.used)), "aria-label": t(w.name) }), w.resetsAt && h("small", null, `${t("resets")} ${date(w.resetsAt)}${Date.parse(w.resetsAt) <= Date.now() ? " \xB7 " + t("old") : ""}`))), usage?.observedAt && h("small", null, `${t("observed")}: ${date(usage.observedAt)}`), onRefresh ? button(t(loading ? "checking" : "refresh"), onRefresh, { disabled: loading }) : h("small", null, t("eventUsage")), error && h("p", { role: "alert" }, t("unknown")));
}
function AssistantHeader({ lang = "en", title, document: document2, onNew, onHistory, onClose, busy = false }) {
  const t = (k) => uiText(lang, k);
  return h("div", { className: "eai eai-header" }, h("div", { className: "eai-header-top" }, h("strong", null, "\u2726 " + t("title")), h("div", { className: "eai-actions" }, button("+", onNew, { disabled: busy, title: t("newChat"), "aria-label": t("newChat") }), button("\u25F7", onHistory, { title: t("history"), "aria-label": t("history") }), button("\xD7", onClose, { title: t("close"), "aria-label": t("close") }))), title && h("div", { className: "eai-title" }, title), document2 && h("small", null, document2));
}
function ConversationList({ lang = "en", items, current, busy = false, onOpen, onDelete }) {
  const [query, setQuery] = useState("");
  const t = (k) => uiText(lang, k), today = (/* @__PURE__ */ new Date()).toDateString(), yesterday = new Date(Date.now() - 864e5).toDateString();
  let group = "";
  return h("section", { className: "eai eai-history", "aria-label": t("history") }, h("input", { "aria-label": t("search"), placeholder: t("search"), value: query, onChange: (e) => setQuery(e.target.value) }), ...items.filter((s) => (s.title + " " + (s.account ?? "")).toLowerCase().includes(query.toLowerCase())).map((s) => {
    const date = new Date(s.updated), g = date.toDateString() === today ? "today" : date.toDateString() === yesterday ? "yesterday" : "earlier", heading = g !== group ? t(g) : null;
    group = g;
    return h("div", { key: s.id }, heading && h("h4", null, heading), h("div", { className: "eai-history-row" }, button(s.title, () => onOpen(s.id), { disabled: busy, "aria-current": s.id === current ? "true" : void 0 }), h("small", null, s.account), button("\xD7", () => onDelete(s.id), { disabled: busy, "aria-label": t("remove") + ": " + s.title })));
  }), !items.length && h("p", null, t("empty")));
}
function ModePicker({lang='en',value,onChange,disabled=false,plan=false}) {
  const t=k=>uiText(lang,k),modes=['ask','auto',...(plan?['plan']:[])],current=modes.includes(value)?value:'ask';
  return h(UpwardMenu,{kind:'mode',label:`${t('mode')}: ${t(current)}`,disabled,chip:h('span',{className:'eai-mode-chip'},h(MenuIcon,{name:current}),h('span',null,t(`${current}Short`)))},close=>modes.map(mode=>button(h('span',{className:'eai-menu-row'},h(MenuIcon,{name:mode}),h('span',{className:'eai-menu-text'},h('span',null,t(mode)),h('small',{className:'eai-menu-hint'},t(`${mode}Hint`))),mode===current&&h(MenuIcon,{name:'check'})),()=>{onChange(mode);close();},{key:mode,role:'menuitemradio','aria-checked':mode===current,className:`eai-menu-item${mode===current?' is-on':''}`})));
}
function QuestionCard({ lang = "en", question, options = [], answered = false, onAnswer }) {
  const [text, setText] = useState("");
  const t = (k) => uiText(lang, k);
  return h("form", { className: "eai eai-question", onSubmit: (e) => {
    e.preventDefault();
    if (text.trim()) onAnswer(text.trim());
  } }, h("fieldset", { disabled: answered }, h("legend", null, question), h("div", { className: "eai-actions" }, ...options.map((o) => button(o, () => setText(o), { key: o, "aria-pressed": o === text }))), h("input", { "aria-label": t("freeAnswer"), placeholder: t("freeAnswer"), value: text, onChange: (e) => setText(e.target.value) }), h("button", { type: "submit", disabled: !text.trim() }, t("answer"))), answered && h("small", null, t("answered")));
}
export {
  AccountPicker,
  AdvancedSettings,
  AssistantAccounts,
  AssistantHeader,
  ConversationList,
  ModePicker,
  ModelOptions,
  PROVIDER_CATALOG as PROVIDERS,
  ProviderSetup,
  QuestionCard,
  SignIn,
  UsageSummary,
  installationCommand as installation,
  normalizeOptions,
  uiText
};

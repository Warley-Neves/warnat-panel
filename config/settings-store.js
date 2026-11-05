// ==============================================================================
// Armazenamento de Configurações por Tenant - WarNat Tech
// ------------------------------------------------------------------------------
// Fonte da verdade: PostgreSQL (container Docker "evolution_postgres"),
// schema dedicado "warnat_panel" (nao interfere nas tabelas da Evolution API).
//
// Leitura SINCRONA em memoria (cache) para o motor de atendimento nunca travar:
//   - Quem salva pelo painel atualiza o cache na hora (mesmo processo).
//   - Outros processos relem o banco a cada REFRESH_MS (padrao 5s).
//   - Se o banco ficar indisponivel, o bot segue com o ultimo valor conhecido
//     (espelho em data/tenant_settings.json). A GRAVACAO, porem, exige o banco.
// ==============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIRROR_FILE = path.join(ROOT, 'data', 'tenant_settings.json');
const REFRESH_MS = 5000;

// ---------------------------------------------------------------- .env (leitura)
function readEnvFile() {
  const map = {};
  const p = path.join(ROOT, '.env');
  if (fs.existsSync(p)) {
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([^#=\s][^=]*)=(.*)$/);
      if (m) map[m[1].trim()] = m[2].trim();
    });
  }
  return map;
}
const ENV = readEnvFile();
const env = (k, d) => process.env[k] || ENV[k] || d;

const DEFAULT_TENANT = env('INSTANCE_NAME', 'warnat-tech');

// ------------------------------------------------------------------ Padroes
const DAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const DAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function buildDefaults() {
  const bh = {};
  for (let d = 0; d < 7; d++) bh[d] = { enabled: true, start: '08:00', end: '20:00' };
  return {
    assistantName: 'Nat',
    companyName: 'WarNat Tech',
    timezone: 'America/Sao_Paulo',
    baseAddress: '',

    // Mensagens (placeholders: {assistente} {empresa} {cliente} {horarios} {proxima_abertura} {saudacao} {endereco_base})
    greetingMessage:
      'Olá! Sou a *{assistente}*, assistente virtual da *{empresa}*. Que bom te ver por aqui! ' +
      'Como posso ajudar hoje? Você quer um orçamento para CFTV, detalhes sobre automação residencial, ' +
      'ou precisa de um suporte técnico?\n\n' +
      'Se preferir falar com uma pessoa da nossa equipe, é só me avisar a qualquer momento.',
    disclosureLine:
      'Olá! Sou a *{assistente}*, assistente virtual da *{empresa}*. ' +
      'Se preferir falar com uma pessoa da nossa equipe, é só me avisar.',
    humanHandoffMessage:
      'Claro! Já avisei a nossa equipe e uma pessoa vai continuar esse atendimento com você por aqui. ' +
      'Agradeço a paciência!',
    outOfHoursMessage:
      'Olá! Sou a *{assistente}*, assistente virtual da *{empresa}*. No momento estamos fora do horário de atendimento ({horarios}). ' +
      'Já registrei sua mensagem e *{proxima_abertura}* damos continuidade ao seu atendimento por aqui.',
    openingMessage:
      '{saudacao}! Sou a *{assistente}*, assistente virtual da *{empresa}*. ' +
      'Conforme combinado, estamos iniciando o atendimento agora. Como posso te ajudar com as suas câmeras de segurança?',

    // Quando a automacao atua (por dia da semana, 0 = domingo)
    businessHours: bh,

    // Quando visitas tecnicas / instalacoes podem ser marcadas (cada janela gera horarios automaticamente)
    bookingWindows: [{ day: 6, start: '08:00', end: '18:00' }],
    visitDurationMinutes: 90,
    bufferMinutes: 30,
    minLeadHours: 2
  };
}

/** Semente para o primeiro uso: aproveita APPOINTMENT_* do .env (versao anterior do projeto). */
function buildSeedFromLegacyEnv() {
  const s = buildDefaults();
  const dayMap = { domingo: 0, dom: 0, segunda: 1, seg: 1, terca: 2, 'terça': 2, ter: 2, quarta: 3, qua: 3, quinta: 4, qui: 4, sexta: 5, sex: 5, sabado: 6, 'sábado': 6, sab: 6 };
  const rawDays = env('APPOINTMENT_DAYS', '');
  if (rawDays) {
    let days = [];
    if (/^(todos|all)$/i.test(rawDays.trim())) days = [1, 2, 3, 4, 5, 6];
    else rawDays.toLowerCase().split(/[,\s;/]+/).forEach(p => { if (dayMap[p] !== undefined && !days.includes(dayMap[p])) days.push(dayMap[p]); });
    if (days.length) {
      const start = normalizeTime(env('APPOINTMENT_START_HOUR', '08:00')) || '08:00';
      const end = normalizeTime(env('APPOINTMENT_END_HOUR', '18:00')) || '18:00';
      s.bookingWindows = days.map(day => ({ day, start, end }));
    }
  }
  return s;
}

// ------------------------------------------------------------ Utilitarios
function normalizeTime(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^([01]?\d|2[0-3])(?::([0-5]\d))?(?:h)?$/i);
  if (!m) return null;
  return `${String(m[1]).padStart(2, '0')}:${m[2] || '00'}`;
}
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('pt-BR', { timeZone: tz }); return true; } catch (e) { return false; }
}

/** Data/hora "de parede" no fuso do tenant. weekday: 0 = domingo */
function getZonedParts(date = new Date(), timezone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  const wk = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')) % 24, minute: Number(get('minute')), weekday: wk
  };
}

function renderTemplate(tpl, vars = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (all, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : all));
}

function mergeSettings(base, patch) {
  const out = JSON.parse(JSON.stringify(base));
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'businessHours' && v && typeof v === 'object') {
      for (let d = 0; d < 7; d++) if (v[d] !== undefined) out.businessHours[d] = { ...out.businessHours[d], ...v[d] };
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// -------------------------------------------------------------- Validacao
const HUMAN_OPTION_RE = /(pessoa|humano|atendente|equipe|time)/i;
const DISCLOSURE_RE = /assistente\s+virtual/i;

/**
 * Valida e normaliza. Retorna { ok, errors[], value }.
 * Regras de transparencia: toda mensagem de primeiro contato deve se declarar "assistente virtual"
 * e a saudacao/linha de apresentacao deve oferecer atendimento humano.
 */
function validateSettings(input) {
  const errors = [];
  const v = JSON.parse(JSON.stringify(input || {}));
  const str = (k, label, max, required = true) => {
    if (typeof v[k] !== 'string') v[k] = v[k] == null ? '' : String(v[k]);
    v[k] = v[k].trim();
    if (required && !v[k]) errors.push(`${label} é obrigatório.`);
    if (v[k].length > max) errors.push(`${label} excede ${max} caracteres.`);
  };

  str('assistantName', 'Nome da assistente', 40);
  str('companyName', 'Nome da empresa', 80);
  str('baseAddress', 'Endereço base', 250, false);
  str('greetingMessage', 'Saudação inicial', 1200);
  str('disclosureLine', 'Linha de apresentação', 500);
  str('humanHandoffMessage', 'Mensagem de transferência para humano', 600);
  str('outOfHoursMessage', 'Mensagem de fora do expediente', 800);
  str('openingMessage', 'Mensagem de abertura do expediente', 800);

  if (!isValidTimezone(v.timezone)) errors.push('Fuso horário inválido.');

  const vars = { assistente: v.assistantName, empresa: v.companyName, cliente: 'Cliente', horarios: 'seg a sáb', proxima_abertura: 'amanhã às 08:00', saudacao: 'Bom dia', endereco_base: v.baseAddress };
  for (const [k, label] of [['greetingMessage', 'Saudação inicial'], ['disclosureLine', 'Linha de apresentação'], ['outOfHoursMessage', 'Mensagem de fora do expediente'], ['openingMessage', 'Mensagem de abertura']]) {
    if (v[k] && !DISCLOSURE_RE.test(renderTemplate(v[k], vars))) {
      errors.push(`${label} deve declarar que se trata de uma "assistente virtual" (transparência obrigatória, CDC/LGPD).`);
    }
  }
  for (const [k, label] of [['greetingMessage', 'Saudação inicial'], ['disclosureLine', 'Linha de apresentação']]) {
    if (v[k] && !HUMAN_OPTION_RE.test(v[k])) {
      errors.push(`${label} deve oferecer a opção de falar com uma pessoa da equipe (ex.: "se preferir falar com uma pessoa da nossa equipe, é só me avisar").`);
    }
  }

  // Horario de atendimento
  const bh = {};
  let anyOpen = false;
  for (let d = 0; d < 7; d++) {
    const raw = (v.businessHours || {})[d] || {};
    const enabled = raw.enabled === true || raw.enabled === 'true';
    const start = normalizeTime(raw.start), end = normalizeTime(raw.end);
    if (enabled) {
      anyOpen = true;
      if (!start || !end) errors.push(`Horário de atendimento (${DAY_NAMES[d]}): informe início e fim no formato HH:MM.`);
      else if (toMin(end) <= toMin(start)) errors.push(`Horário de atendimento (${DAY_NAMES[d]}): o fim deve ser depois do início.`);
    }
    bh[d] = { enabled, start: start || '08:00', end: end || '20:00' };
  }
  if (!anyOpen) errors.push('Ative pelo menos um dia de atendimento.');
  v.businessHours = bh;

  // Duracao / intervalo / antecedencia
  const num = (k, label, min, max) => {
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n < min || n > max) errors.push(`${label} deve estar entre ${min} e ${max}.`);
    v[k] = Math.round(Number.isFinite(n) ? n : min);
  };
  num('visitDurationMinutes', 'Duração da visita (min)', 15, 480);
  num('bufferMinutes', 'Intervalo entre visitas (min)', 0, 240);
  num('minLeadHours', 'Antecedência mínima (h)', 0, 168);

  // Janelas de agendamento
  const wins = Array.isArray(v.bookingWindows) ? v.bookingWindows : [];
  const cleanWins = [];
  if (!wins.length) errors.push('Cadastre pelo menos uma janela de agendamento (dia e horários liberados para visitas).');
  wins.forEach((w, i) => {
    const day = Number(w && w.day), start = normalizeTime(w && w.start), end = normalizeTime(w && w.end);
    if (!Number.isInteger(day) || day < 0 || day > 6) return errors.push(`Janela ${i + 1}: dia da semana inválido.`);
    if (!start || !end) return errors.push(`Janela ${i + 1} (${DAY_NAMES[day]}): informe início e fim no formato HH:MM.`);
    if (toMin(end) <= toMin(start)) return errors.push(`Janela ${i + 1} (${DAY_NAMES[day]}): o fim deve ser depois do início.`);
    if (toMin(end) - toMin(start) < v.visitDurationMinutes) return errors.push(`Janela ${i + 1} (${DAY_NAMES[day]}): é menor que a duração da visita (${v.visitDurationMinutes} min).`);
    cleanWins.push({ day, start, end });
  });
  cleanWins.sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
  for (let i = 1; i < cleanWins.length; i++) {
    const p = cleanWins[i - 1], c = cleanWins[i];
    if (p.day === c.day && toMin(c.start) < toMin(p.end)) errors.push(`Janelas de ${DAY_NAMES[c.day]} se sobrepõem.`);
  }
  v.bookingWindows = cleanWins;

  return { ok: errors.length === 0, errors, value: v };
}

// ------------------------------------------------- Regras de horario (puras)
function isOpenAt(settings, date = new Date()) {
  const z = getZonedParts(date, settings.timezone);
  const day = settings.businessHours[z.weekday];
  if (!day || !day.enabled) return false;
  const nowMin = z.hour * 60 + z.minute;
  return nowMin >= toMin(day.start) && nowMin < toMin(day.end);
}

/** Proxima abertura: { label: 'hoje às 08:00' | 'amanhã às 08:00' | 'na segunda-feira às 08:00', time, offsetDays } */
function getNextOpening(settings, date = new Date()) {
  const z = getZonedParts(date, settings.timezone);
  const nowMin = z.hour * 60 + z.minute;
  for (let off = 0; off <= 7; off++) {
    const wd = (z.weekday + off) % 7;
    const day = settings.businessHours[wd];
    if (!day || !day.enabled) continue;
    if (off === 0 && nowMin >= toMin(day.start)) continue; // hoje ja abriu (ou ja passou)
    const label = off === 0 ? `hoje às ${day.start}` : off === 1 ? `amanhã às ${day.start}` : `${wd === 0 || wd === 6 ? 'no' : 'na'} ${DAY_NAMES[wd]} às ${day.start}`;
    return { label, time: day.start, weekday: wd, offsetDays: off };
  }
  return null;
}

/** "segunda a sábado, das 08:00 às 20:00" (agrupa dias consecutivos com o mesmo horario) */
function describeBusinessHours(settings) {
  const groups = [];
  for (let d = 0; d < 7; d++) {
    const day = settings.businessHours[d];
    if (!day || !day.enabled) continue;
    const key = `${day.start}-${day.end}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key && last.days[last.days.length - 1] === d - 1) last.days.push(d);
    else groups.push({ key, start: day.start, end: day.end, days: [d] });
  }
  const dn = d => DAY_NAMES[d].replace('-feira', '');
  return groups.map(g => {
    const range = g.days.length === 1 ? dn(g.days[0]) : g.days.length === 2 ? `${dn(g.days[0])} e ${dn(g.days[1])}` : `${dn(g.days[0])} a ${dn(g.days[g.days.length - 1])}`;
    return `${range}, das ${g.start} às ${g.end}`;
  }).join('; ');
}

/** Resumo das janelas: "sábado das 08:00 às 18:00" */
function describeBookingWindows(settings) {
  const byDay = {};
  settings.bookingWindows.forEach(w => { (byDay[w.day] = byDay[w.day] || []).push(`${w.start} às ${w.end}`); });
  return Object.keys(byDay).map(Number).sort().map(d => `${DAY_NAMES[d]} das ${byDay[d].join(' e das ')}`).join('; ');
}

function greetingForHour(hour) {
  return hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
}

/** Variaveis de template de um tenant no instante atual */
function buildTemplateVars(settings, extra = {}, date = new Date()) {
  const z = getZonedParts(date, settings.timezone);
  const next = getNextOpening(settings, date);
  return {
    assistente: settings.assistantName,
    empresa: settings.companyName,
    horarios: describeBusinessHours(settings),
    proxima_abertura: next ? next.label : 'em breve',
    saudacao: greetingForHour(z.hour),
    endereco_base: settings.baseAddress || '',
    ...extra
  };
}

// ----------------------------------------------------------------- Armazenamento
class SettingsStore {
  constructor() {
    this.cache = new Map();   // tenantId -> { config, updatedAt, updatedBy, version }
    this.pool = null;
    this.dbOk = false;
    this.lastError = null;
    this.lastRefreshAt = null;
    this.listeners = [];
    this.initPromise = null;
    this._loadMirror();
    this.initPromise = this.init();
  }

  _loadMirror() {
    try {
      if (fs.existsSync(MIRROR_FILE)) {
        const raw = JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8'));
        for (const [id, row] of Object.entries(raw)) this.cache.set(id, row);
      }
    } catch (e) { /* espelho corrompido: ignora, banco restaura */ }
  }

  _writeMirror() {
    try {
      fs.mkdirSync(path.dirname(MIRROR_FILE), { recursive: true });
      const obj = {};
      for (const [id, row] of this.cache.entries()) obj[id] = row;
      fs.writeFileSync(MIRROR_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) { /* nao critico */ }
  }

  async init() {
    try {
      const { Pool } = require('pg');
      const connUri = env('DATABASE_CONNECTION_URI') || env('DATABASE_URL');
      const poolConfig = connUri ? {
        connectionString: connUri,
        ssl: connUri.includes('localhost') || connUri.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
        max: 4,
        connectionTimeoutMillis: 5000
      } : {
        host: env('POSTGRES_HOST', '127.0.0.1'),
        port: Number(env('POSTGRES_PORT', '5432')),
        user: env('POSTGRES_USER', 'evolution_user'),
        password: env('POSTGRES_PASSWORD', 'sua_senha_forte_aqui'),
        database: env('POSTGRES_DB', 'evolution_db'),
        max: 4,
        connectionTimeoutMillis: 4000
      };
      this.pool = new Pool(poolConfig);
      this.pool.on('error', e => { this.dbOk = false; this.lastError = e.message; });

      try {
        await this.pool.query('CREATE SCHEMA IF NOT EXISTS warnat_panel');
      } catch (schemaErr) {
        if (!/unique constraint|already exists/i.test(schemaErr.message)) throw schemaErr;
      }
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS warnat_panel.tenant_settings (
            tenant_id  text PRIMARY KEY,
            config     jsonb NOT NULL,
            version    integer NOT NULL DEFAULT 1,
            updated_at timestamptz NOT NULL DEFAULT now(),
            updated_by text
          )`);
      } catch (tableErr) {
        if (!/unique constraint|already exists/i.test(tableErr.message)) throw tableErr;
      }
      this.dbOk = true;
      this.lastError = null;

      // Semente: tenant padrao sem linha => espelho local > .env legado > padroes
      const exists = await this.pool.query('SELECT 1 FROM warnat_panel.tenant_settings WHERE tenant_id = $1', [DEFAULT_TENANT]);
      if (!exists.rowCount) {
        const mirrored = this.cache.get(DEFAULT_TENANT);
        const seed = mirrored ? mirrored.config : buildSeedFromLegacyEnv();
        const v = validateSettings(mergeSettings(buildDefaults(), seed));
        await this.pool.query(
          'INSERT INTO warnat_panel.tenant_settings (tenant_id, config, updated_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [DEFAULT_TENANT, JSON.stringify(v.ok ? v.value : buildDefaults()), 'seed']
        );
        console.log(`[SettingsStore] Configuração inicial do tenant "${DEFAULT_TENANT}" gravada no PostgreSQL.`);
      }
      await this.refresh();
      const t = setInterval(() => this.refresh().catch(() => {}), REFRESH_MS);
      if (t.unref) t.unref();
      console.log('[SettingsStore] Conectado ao PostgreSQL (schema warnat_panel).');
    } catch (e) {
      this.dbOk = false;
      this.lastError = e.message;
      console.warn(`[SettingsStore] PostgreSQL indisponível (${e.message}). Usando última configuração conhecida (espelho local).`);
      // tenta reconectar periodicamente
      const t = setTimeout(() => { this.initPromise = this.init(); }, 15000);
      if (t.unref) t.unref();
    }
  }

  async refresh() {
    if (!this.pool) return;
    try {
      const r = await this.pool.query('SELECT tenant_id, config, version, updated_at, updated_by FROM warnat_panel.tenant_settings');
      let changed = false;
      for (const row of r.rows) {
        const prev = this.cache.get(row.tenant_id);
        const updatedAt = new Date(row.updated_at).toISOString();
        if (!prev || prev.updatedAt !== updatedAt || prev.version !== row.version) changed = true;
        this.cache.set(row.tenant_id, { config: row.config, version: row.version, updatedAt, updatedBy: row.updated_by });
      }
      this.dbOk = true;
      this.lastError = null;
      this.lastRefreshAt = new Date().toISOString();
      if (changed) { this._writeMirror(); this._emit(); }
    } catch (e) {
      this.dbOk = false;
      this.lastError = e.message;
    }
  }

  _emit() { this.listeners.forEach(fn => { try { fn(); } catch (e) {} }); }
  onChange(fn) { this.listeners.push(fn); }

  /** Leitura SINCRONA (cache) com padroes aplicados. */
  getSettings(tenantId = DEFAULT_TENANT) {
    const row = this.cache.get(tenantId);
    return mergeSettings(row ? mergeSettings(buildDefaults(), row.config) : buildSeedFromLegacyEnv(), {});
  }

  getMeta(tenantId = DEFAULT_TENANT) {
    const row = this.cache.get(tenantId);
    return row ? { updatedAt: row.updatedAt, updatedBy: row.updatedBy, version: row.version } : null;
  }

  async listTenantIds() {
    const ids = new Set(this.cache.keys());
    ids.add(DEFAULT_TENANT);
    return [...ids];
  }

  status() {
    return { dbOk: this.dbOk, lastError: this.lastError, lastRefreshAt: this.lastRefreshAt, defaultTenant: DEFAULT_TENANT };
  }

  /** Valida e grava no PostgreSQL. Lanca erro com .code = 'VALIDATION' | 'DB_DOWN'. */
  async saveSettings(tenantId, patch, updatedBy = 'painel') {
    await this.initPromise;
    const current = this.getSettings(tenantId);
    const merged = mergeSettings(current, patch);
    const v = validateSettings(merged);
    if (!v.ok) { const e = new Error('Configuração inválida'); e.code = 'VALIDATION'; e.details = v.errors; throw e; }
    if (!this.pool || !this.dbOk) {
      try { await this.pool.query('SELECT 1'); this.dbOk = true; } catch (err) {
        const e = new Error('Banco de dados indisponível. Nenhuma alteração foi gravada.'); e.code = 'DB_DOWN'; throw e;
      }
    }
    const r = await this.pool.query(
      `INSERT INTO warnat_panel.tenant_settings (tenant_id, config, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE
         SET config = EXCLUDED.config, version = warnat_panel.tenant_settings.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING version, updated_at`,
      [tenantId, JSON.stringify(v.value), updatedBy]
    );
    // Reflexo IMEDIATO no motor (mesmo processo)
    this.cache.set(tenantId, { config: v.value, version: r.rows[0].version, updatedAt: new Date(r.rows[0].updated_at).toISOString(), updatedBy });
    this._writeMirror();
    this._emit();
    return { settings: this.getSettings(tenantId), meta: this.getMeta(tenantId) };
  }

  /** Leitura direta da linha no banco (usada nos testes de validacao). */
  async readRowFromDb(tenantId = DEFAULT_TENANT) {
    await this.initPromise;
    const r = await this.pool.query('SELECT tenant_id, config, version, updated_at, updated_by FROM warnat_panel.tenant_settings WHERE tenant_id = $1', [tenantId]);
    return r.rows[0] || null;
  }
}

const store = new SettingsStore();

module.exports = {
  store,
  DEFAULT_TENANT,
  DAY_NAMES,
  DAY_SHORT,
  buildDefaults,
  validateSettings,
  mergeSettings,
  renderTemplate,
  buildTemplateVars,
  getZonedParts,
  isOpenAt,
  getNextOpening,
  describeBusinessHours,
  describeBookingWindows,
  greetingForHour,
  normalizeTime,
  toMin,
  DISCLOSURE_RE,
  getSettings: (id) => store.getSettings(id),
  saveSettings: (id, patch, by) => store.saveSettings(id, patch, by)
};

const DIAS_SEMANA_NOMES = [
  'Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'
];

function parseLocalDate(dateVal) {
  if (!dateVal) return new Date();
  if (dateVal instanceof Date) {
    if (isNaN(dateVal.getTime())) return new Date();
    return new Date(dateVal.getFullYear(), dateVal.getMonth(), dateVal.getDate(), 12, 0, 0);
  }
  const str = String(dateVal).trim();
  const ymdMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymdMatch) {
    return new Date(parseInt(ymdMatch[1], 10), parseInt(ymdMatch[2], 10) - 1, parseInt(ymdMatch[3], 10), 12, 0, 0);
  }
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dmyMatch) {
    const d = parseInt(dmyMatch[1], 10);
    const m = parseInt(dmyMatch[2], 10);
    let y = dmyMatch[3] ? parseInt(dmyMatch[3], 10) : new Date().getFullYear();
    if (y < 100) y += 2000;
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) {
    if (str.includes('T')) {
      const brStr = fallback.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const [dd, mm, yyyy] = brStr.split('/').map(Number);
      return new Date(yyyy, mm - 1, dd, 12, 0, 0);
    }
    return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate(), 12, 0, 0);
  }
  return new Date();
}

function getDayOfWeekInfo(dateVal) {
  const d = parseLocalDate(dateVal);
  const dayIndex = d.getDay();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return {
    dayOfWeek: DIAS_SEMANA_NOMES[dayIndex],
    dayIndex,
    formattedBr: `${dd}/${mm}`,
    formattedFullBr: `${dd}/${mm}/${yyyy}`,
    isoDate: `${yyyy}-${mm}-${dd}`
  };
}

const ANOTHER_DATE_INTENTS = [
  /outro\s+dia/i,
  /outra\s+data/i,
  /outro\s+s[aá]bado/i,
  /outros?\s+dias?/i,
  /outras?\s+datas?/i,
  /outra\s+semana/i,
  /semana\s+que\s+vem/i,
  /pr[oó]xim[ao]\s+semana/i,
  /pr[oó]xim[ao]\s+s[aá]bado/i,
  /pr[oó]xim[ao]\s+fim\s+de\s+semana/i,
  /pr[oó]xim[ao]\s+final\s+de\s+semana/i,
  /mais\s+pra\s+frente/i,
  /mais\s+para\s+frente/i,
  /mais\s+adiante/i,
  /mais\s+al[eé]m/i,
  /mudar\s+(de\s+)?data/i,
  /trocar\s+(de\s+)?data/i,
  /data\s+diferente/i,
  /dia\s+diferente/i,
  /tem\s+outro\s+dia/i,
  /tem\s+outra\s+data/i,
  /tem\s+outro\s+s[aá]bado/i,
  /algum\s+outro\s+dia/i,
  /alguma\s+outra\s+data/i,
  /n[aã]o\s+posso\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /n[aã]o\s+d[aá]\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /n[aã]o\s+consigo\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /n[aã]o\s+posso\s+dia/i,
  /n[aã]o\s+posso\s+no\s+dia/i,
  /n[aã]o\s+d[aá]\s+dia/i,
  /n[aã]o\s+d[aá]\s+no\s+dia/i,
  /n[aã]o\s+consigo\s+dia/i,
  /n[aã]o\s+consigo\s+no\s+dia/i,
  /ocupad[ao]\s+(no|nesse|naquele|neste)\s+(dia|s[aá]bado)/i,
  /indispon[ií]vel\s+(no|nesse|naquele|neste)\s+(dia|s[aá]bado)/i,
  /sem\s+disponibilidade\s+(no|nesse|naquele|neste)\s+(dia|s[aá]bado)/i,
  /n[aã]o\s+tenho\s+como\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /n[aã]o\s+tenho\s+disponibilidade\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /nesse\s+s[aá]bado\s+n[aã]o\s+(posso|d[aá]|consigo)/i,
  /nessa\s+data\s+n[aã]o\s+(posso|d[aá]|consigo)/i,
  /nesse\s+dia\s+n[aã]o\s+(posso|d[aá]|consigo)/i,
  /(dia|data|s[aá]bado)[\s\S]{0,15}n[aã]o\s+(d[aá]|posso|consigo)/i,
  /n[aã]o\s+(d[aá]|posso|consigo)[\s\S]{0,15}(dia|data|s[aá]bado)/i,
  /s[aá]bado\s+seguinte/i,
  /dia\s+seguinte/i,
  /semana\s+seguinte/i,
  /tem\s+outr[ao]\??$/i,
  /algum\s+outr[ao]\??$/i,
  /n[aã]o\s+posso\s+em\s+nenhum/i,
  /n[aã]o\s+posso\s+ness[ae]s/i,
  /n[aã]o\s+posso\s*,?\s*tem/i
];

function extractDatesFromText(text) {
  const dates = [];
  if (!text || typeof text !== 'string') return dates;
  const now = new Date();

  const isoMatches = text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g);
  for (const m of isoMatches) {
    if (!dates.includes(m[0])) dates.push(m[0]);
  }

  const brMatches = text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g);
  for (const m of brMatches) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      let y = m[3] ? parseInt(m[3], 10) : now.getFullYear();
      if (y < 100) y += 2000;
      const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!dates.includes(iso)) dates.push(iso);
    }
  }

  return dates;
}

// Test cases
const tests = [
  { text: "Não posso no sábado 07/11, tem outro sábado?", expectIntent: true, dates: ['2026-11-07'] },
  { text: "tem outro dia disponível?", expectIntent: true, dates: [] },
  { text: "tem algum sábado mais pra frente?", expectIntent: true, dates: [] },
  { text: "nesse sábado não posso, semana que vem dá?", expectIntent: true, dates: [] },
  { text: "dia 07/11 não dá para mim", expectIntent: true, dates: ['2026-11-07'] },
  { text: "não posso, tem outro?", expectIntent: true, dates: [] },
  { text: "Prefiro no sábado dia 07/11 às 08:00", expectIntent: false, dates: ['2026-11-07'] },
  { text: "Pode marcar para as 10h", expectIntent: false, dates: [] },
  { text: "Não tenho como nesse sábado", expectIntent: true, dates: [] },
  { text: "Não tenho disponibilidade nessa data", expectIntent: true, dates: [] },
  { text: "Tem outro sábado além desse?", expectIntent: true, dates: [] },
  { text: "Vocês tem disponibilidade no sábado seguinte?", expectIntent: true, dates: [] },
  { text: "Sábado que vem fica difícil, tem mais pra frente?", expectIntent: true, dates: [] },
  { text: "Pode ser dia 14/11?", expectIntent: false, dates: ['2026-11-14'] }
];

let allPassed = true;
tests.forEach((t, i) => {
  const matched = ANOTHER_DATE_INTENTS.some(regex => regex.test(t.text));
  const dates = extractDatesFromText(t.text);
  const intentOk = matched === t.expectIntent;
  const datesOk = JSON.stringify(dates) === JSON.stringify(t.dates);
  if (intentOk && datesOk) {
    console.log(`[PASS] Test ${i + 1}: "${t.text}" => intent=${matched}, dates=${JSON.stringify(dates)}`);
  } else {
    console.error(`[FAIL] Test ${i + 1}: "${t.text}" => got intent=${matched} (expected ${t.expectIntent}), dates=${JSON.stringify(dates)} (expected ${JSON.stringify(t.dates)})`);
    allPassed = false;
  }
});

if (allPassed) {
  console.log('\nAll date & intent helper tests passed!');
  process.exit(0);
} else {
  process.exit(1);
}

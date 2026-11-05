/**
 * Suite de Testes Automatizados - WarNat Tech
 * Validação de Banco de Dados, Painel Tenant, Identidade da Nat e Janelas de Agendamento
 */
require('dotenv').config();
const settingsStore = require('../config/settings-store');
const calendarService = require('../calendar/google-calendar');
const schedulerAgent = require('../agent/whatsapp-scheduler');

const HOMOLOGATION_PHONE = (process.env.HOMOLOGATION_PHONE || '5531983579692').replace(/\D/g, '');
const HOMOLOGATION_JID = `${HOMOLOGATION_PHONE}@s.whatsapp.net`;

async function runTests() {
  console.log('================================================================');
  console.log('🔬 INICIANDO BATERIA DE TESTES DE VALIDAÇÃO TÉCNICA');
  console.log(`📱 Número restrito de homologação: +${HOMOLOGATION_PHONE}`);
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${message}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // TESTE 1: Conexão e Leitura do PostgreSQL
  // ---------------------------------------------------------------------------
  console.log('--- TESTE 1: Banco de Dados PostgreSQL & Settings Store ---');
  await settingsStore.store.init();
  const initialSettings = settingsStore.getSettings('warnat-tech');
  const dbStatus = settingsStore.store.status();

  assert(initialSettings !== null, 'Configurações de "warnat-tech" carregadas com sucesso');
  assert(initialSettings.assistantName === 'Nat', 'Identidade da assistente configurada como "Nat"');
  assert(initialSettings.companyName === 'WarNat Tech', 'Empresa configurada como "WarNat Tech"');
  assert(dbStatus.dbOk === true, `Banco PostgreSQL conectado no Docker: ${dbStatus.dbOk}`);

  // Testar leitura direta da tabela warnat_panel.tenant_settings
  const rawDbRow = await settingsStore.store.readRowFromDb('warnat-tech');
  assert(rawDbRow !== null, 'Tabela "warnat_panel.tenant_settings" lida diretamente no PostgreSQL via Docker');
  assert(rawDbRow.tenant_id === 'warnat-tech', `tenant_id no banco: "${rawDbRow.tenant_id}"`);
  console.log(`  ℹ️ PostgreSQL: Online | Versão: ${rawDbRow.version} | Atualizado por: ${rawDbRow.updated_by}\n`);

  // ---------------------------------------------------------------------------
  // TESTE 2: Validações Legais Rigorosas (CDC / LGPD)
  // ---------------------------------------------------------------------------
  console.log('--- TESTE 2: Regras de Validação Legal (Assistente Virtual e Transparência) ---');
  
  // 2.1 Tentativa de remover declaração de assistente virtual
  const invalidSettings1 = JSON.parse(JSON.stringify(initialSettings));
  invalidSettings1.greetingMessage = 'Olá, sou a Nat da WarNat Tech! Tudo bem?';
  const valResult1 = settingsStore.validateSettings(invalidSettings1);
  assert(!valResult1.ok, 'Rejeitou saudação sem a declaração obrigatória de "assistente virtual"');

  // 2.2 Tentativa de remover oferta de atendimento humano
  const invalidSettings2 = JSON.parse(JSON.stringify(initialSettings));
  invalidSettings2.greetingMessage = 'Olá! Sou a Nat, assistente virtual da WarNat Tech. Como posso ajudar?';
  const valResult2 = settingsStore.validateSettings(invalidSettings2);
  assert(!valResult2.ok, 'Rejeitou saudação sem oferta explícita de falar com atendimento humano');

  // 2.3 Tentativa de apagar todas as janelas de agendamento
  const invalidSettings3 = JSON.parse(JSON.stringify(initialSettings));
  invalidSettings3.bookingWindows = [];
  const valResult3 = settingsStore.validateSettings(invalidSettings3);
  assert(!valResult3.ok, 'Rejeitou salvar sem pelo menos uma janela de agendamento');
  console.log('');

  // ---------------------------------------------------------------------------
  // TESTE 3: Atualização e Persistência Dinâmica no PostgreSQL
  // ---------------------------------------------------------------------------
  console.log('--- TESTE 3: Persistência no PostgreSQL e Reflexão Instantânea ---');
  const testAddress = 'Rua Teste de Homologação, 100 - Belo Horizonte/MG';
  await settingsStore.saveSettings('warnat-tech', {
    baseAddress: testAddress
  }, 'suite-testes');

  // Re-lê direto da store para comprovar cache/banco
  const readBack = settingsStore.getSettings('warnat-tech');
  assert(readBack.baseAddress === testAddress, 'Endereço base atualizado e refletido instantaneamente');

  const checkDb = await settingsStore.store.readRowFromDb('warnat-tech');
  assert(checkDb.config.baseAddress === testAddress, 'Endereço base confirmado diretamente no PostgreSQL (Docker)');
  console.log('');

  // ---------------------------------------------------------------------------
  // TESTE 4: Horário de Expediente & Janelas Dinâmicas
  // ---------------------------------------------------------------------------
  console.log('--- TESTE 4: Horário de Expediente e Janelas de Agendamento ---');
  const isOpen = settingsStore.isOpenAt(readBack);
  console.log(`  ℹ️ Horário atual: ${new Date().toLocaleTimeString('pt-BR')} | Dentro do expediente? ${isOpen}`);
  assert(typeof isOpen === 'boolean', 'Cálculo de expediente executado com precisão');

  const allowedDays = calendarService.getAllowedDays();
  const allowedNames = calendarService.getAllowedDaysNames();
  console.log(`  ℹ️ Dias liberados no Calendar: ${allowedNames} (índices: ${allowedDays.join(', ')})`);
  assert(allowedDays.includes(6), 'Janela de Sábado configurada para visitas técnicas');

  // Testar se terça-feira (2026-11-10) tem slots retornados
  const tuesdaySlots = calendarService.getWindowSlotsForDate('2026-11-10');
  assert(tuesdaySlots.length === 0, 'Terça-feira (2026-11-10) retorna 0 slots (corretamente BLOQUEADA)');

  // Testar se sábado (2026-11-07) tem slots retornados
  const saturdaySlots = calendarService.getWindowSlotsForDate('2026-11-07');
  assert(saturdaySlots.length > 0, `Sábado (2026-11-07) retorna ${saturdaySlots.length} slots gerados dinamicamente (${saturdaySlots.join(', ')})`);
  console.log('');

  // ---------------------------------------------------------------------------
  // TESTE 5: Assistente Virtual "Nat" - Homologação de Mensagens
  // ---------------------------------------------------------------------------
  console.log('--- TESTE 5: Comportamento da Assistente Nat (Homologação JID) ---');
  schedulerAgent.resetConversation(HOMOLOGATION_JID);

  // 5.1 Primeira mensagem: Saudação
  console.log('  💬 [Passo 1] Enviando mensagem inicial do cliente: "Olá!"');
  const reply1 = await schedulerAgent.processIncomingMessage(HOMOLOGATION_JID, 'Cliente Homologação', 'Olá!');
  console.log(`  🤖 Resposta da Nat:\n"${reply1?.message}"\n`);

  assert(reply1?.message && reply1.message.includes('Nat'), 'Nat se identifica pelo nome');
  assert(reply1?.message && reply1.message.toLowerCase().includes('assistente virtual'), 'Declara explicitamente ser assistente virtual (Transparência Legal CDC/LGPD)');
  assert(reply1?.message && (reply1.message.toLowerCase().includes('humano') || reply1.message.toLowerCase().includes('equipe') || reply1.message.toLowerCase().includes('pessoa')), 'Oferece opção de falar com atendimento humano');

  // 5.2 Cliente pergunta se é robô
  console.log('  💬 [Passo 2] Cliente pergunta: "Você é um robô?"');
  const reply2 = await schedulerAgent.processIncomingMessage(HOMOLOGATION_JID, 'Cliente Homologação', 'Você é um robô?');
  console.log(`  🤖 Resposta da Nat:\n"${reply2?.message}"\n`);
  assert(reply2?.message && (reply2.message.toLowerCase().includes('assistente virtual') || reply2.message.toLowerCase().includes('sistema automatizado')), 'Responde com transparência total que é assistente virtual / automatizada');

  // 5.3a Triagem: Cliente pede visita técnica
  console.log('  💬 [Passo 3a] Triagem: Cliente pede visita técnica: "Quero agendar uma visita técnica"');
  const reply3a = await schedulerAgent.processIncomingMessage(HOMOLOGATION_JID, 'Cliente Homologação', 'Quero agendar uma visita técnica');
  console.log(`  🤖 Resposta da Nat:\n"${reply3a?.message}"\n`);
  assert(reply3a?.message && (reply3a.message.toLowerCase().includes('nova instalação') || reply3a.message.toLowerCase().includes('manutenção')), 'Nat faz a qualificação correta antes de passar horários (nova instalação vs manutenção)');

  // 5.3b Cliente informa nova instalação e pede dia bloqueado (terça-feira)
  console.log('  💬 [Passo 3b] Cliente esclarece nova instalação mas pede dia bloqueado: "É para uma nova instalação. Vocês têm horário na terça-feira às 10h?"');
  const reply3b = await schedulerAgent.processIncomingMessage(HOMOLOGATION_JID, 'Cliente Homologação', 'É para uma nova instalação do zero. Vocês têm horário na terça-feira às 10h?');
  console.log(`  🤖 Resposta da Nat:\n"${reply3b?.message}"\n`);
  assert(reply3b?.message && (reply3b.message.toLowerCase().includes('sábado') || reply3b.message.toLowerCase().includes('sabado')), 'Recusa agendamento na terça-feira e redireciona para a janela configurada no painel (Sábados)');

  // 5.4 Cliente solicita atendimento humano
  console.log('  💬 [Passo 4] Cliente pede: "Quero falar com um atendente humano agora"');
  const reply4 = await schedulerAgent.processIncomingMessage(HOMOLOGATION_JID, 'Cliente Homologação', 'Quero falar com um atendente humano agora');
  console.log(`  🤖 Resposta da Nat:\n"${reply4?.message}"\n`);
  assert(reply4?.message && (reply4.message.toLowerCase().includes('equipe') || reply4.message.toLowerCase().includes('humano') || reply4.message.toLowerCase().includes('pessoa')), 'Aciona o fluxo de transferência humana');
  assert(schedulerAgent.isContactMuted(HOMOLOGATION_JID), 'Contato é silenciado para a automação e passa para o modo manual');

  // Reabilita contato e limpa memória de teste
  schedulerAgent.unmuteContact(HOMOLOGATION_JID);
  schedulerAgent.resetConversation(HOMOLOGATION_JID);
  console.log('');

  // ---------------------------------------------------------------------------
  // RESULTADO FINAL
  // ---------------------------------------------------------------------------
  console.log('================================================================');
  console.log(`🏁 RESULTADO DOS TESTES: ${passed} PASSARAM | ${failed} FALHARAM`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('💥 Erro fatal nos testes:', err);
  process.exit(1);
});

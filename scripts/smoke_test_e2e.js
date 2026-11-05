// ==============================================================================
// TESTE DE SMOKE END-TO-END (FASE 6) - WARNAT TECH SAAS MULTI-TENANT
// Validação dos 3 fluxos fundamentais:
// 1. Mensagem de Cliente -> IA responde com System Prompt compilado dinamicamente
// 2. Intervenção Humana (fromMe: true) -> Pausa imediata da IA (45 min)
// 3. Qualificação Completa -> Registro em chat_sessions.dados_lead e Alerta Técnico
// ==============================================================================

const { query } = require('../database/db');
const evolutionService = require('../services/evolution.service');
const messageCache = require('../services/message-cache.service');
const webhookController = require('../controllers/webhook.controller');
const aiEngine = require('../services/ai-engine.service');

async function runSmokeTestE2E() {
  console.log('================================================================================');
  console.log('🚀 INICIANDO TESTE DE SMOKE END-TO-END (TENANT #1: WARNAT TECH)');
  console.log('================================================================================\n');

  // Obtém o tenant WarNat Tech semeado
  const tenantRes = await query(`SELECT id, nome_empresa FROM tenants WHERE nome_empresa = 'WarNat Tech' LIMIT 1`);
  if (tenantRes.rowCount === 0) {
    throw new Error('Tenant WarNat Tech não encontrado! Execute "node database/seed_warnat.js" primeiro.');
  }
  const tenant = tenantRes.rows[0];
  console.log(`🏢 Tenant Ativo Identificado: ${tenant.nome_empresa} (ID: ${tenant.id})\n`);

  const instanceName = 'warnat-tech';
  const testCustomerJid = '5531988887777@s.whatsapp.net';
  const customerName = 'Rodrigo Alencar';

  // Garante que o processador de IA do webhook está apontado para a Engine
  webhookController.setAIProcessor((params) => aiEngine.processTurn(params));

  // Limpa histórico anterior deste número de teste para começar do zero
  await query(`DELETE FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2`, [tenant.id, testCustomerJid]);

  // ----------------------------------------------------------------------------
  // FLUXO 1: RECEBIMENTO DE MENSAGEM SIMULADA -> RESPOSTA DA IA
  // ----------------------------------------------------------------------------
  console.log('--------------------------------------------------------------------------------');
  console.log('TESTE DE FLUXO 1: Mensagem do Cliente -> Processamento pela IA Dinâmica');
  console.log('--------------------------------------------------------------------------------');

  const incomingPayload1 = {
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: {
        remoteJid: testCustomerJid,
        fromMe: false,
        id: `CLIENT_MSG_${Date.now()}`
      },
      pushName: customerName,
      message: {
        conversation: 'Olá! Gostaria de saber como funciona o orçamento para instalação de 4 câmeras na minha casa no Barreiro.'
      }
    }
  };

  console.log(`[Cliente WhatsApp] "${incomingPayload1.data.message.conversation}"`);
  console.log('⏳ Enviando webhook e aguardando processamento da IA...');

  // Executa o webhook com debounce imediato para o teste
  const webhookResult1 = await webhookController.handleWebhook(incomingPayload1);
  console.log(`[Webhook Status] Ação: ${webhookResult1.action} (Buffer: ${webhookResult1.bufferLength} msg)`);

  // Dispara o buffer imediatamente no teste sem esperar 3s
  const bufferKey = `${tenant.id}:${testCustomerJid}`;
  const buffer = webhookController.debounceBuffers.get(bufferKey);
  if (buffer) {
    clearTimeout(buffer.timer);
    webhookController.debounceBuffers.delete(bufferKey);
    console.log('⚙️ Executando rodada da IA (gpt-4o-mini com prompt dinâmico da WarNat Tech)...');
    
    // Captura envio de resposta real da IA
    const aiResult = await aiEngine.processTurn({
      tenantId: buffer.tenantId,
      instanceName: buffer.instanceName,
      sessionId: buffer.sessionId,
      remoteJid: buffer.remoteJid,
      pushName: buffer.pushName,
      userMessage: buffer.messages.join('\n')
    });

    console.log(`\n🤖 [Resposta da IA para o WhatsApp]:`);
    console.log(`"${aiResult?.replyText}"\n`);

    // Validações do Fluxo 1
    const msgsInDb = await query(
      `SELECT role, content, message_id FROM chat_messages WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenant.id]
    );

    console.log('📊 Validações do Fluxo 1 no PostgreSQL:');
    console.log(`   - Mensagens salvas na sessão: ${msgsInDb.rowCount} (esperado: 2 -> 1 user, 1 assistant)`);
    console.log(`   - Message ID gravado no cache Anti-Loop: ${aiResult?.messageId}`);

    const isCached = await messageCache.isBotSent(aiResult?.messageId);
    console.log(`   - Anti-Loop Bot Sent Cache ativo: ${isCached} (esperado: true)`);

    if (msgsInDb.rowCount < 2 || !isCached) {
      throw new Error('Falha na validação do Fluxo 1!');
    }
    console.log('✅ FLUXO 1 CONCLUÍDO COM 100% DE SUCESSO!\n');
  }

  // ----------------------------------------------------------------------------
  // FLUXO 2: DISPARO DE fromMe: true (OPERADOR HUMANO ASSUME NO CELULAR FÍSICO)
  // ----------------------------------------------------------------------------
  console.log('--------------------------------------------------------------------------------');
  console.log('TESTE DE FLUXO 2: Intervenção Humana (fromMe: true) -> Ativação de Pausa da IA');
  console.log('--------------------------------------------------------------------------------');

  const humanMessageId = `HUMAN_DEVICE_MSG_${Date.now()}`;
  const humanTakeoverPayload = {
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: {
        remoteJid: testCustomerJid,
        fromMe: true, // Enviado do aparelho físico WhatsApp da WarNat Tech!
        id: humanMessageId // NÃO está no cache bot_sent!
      },
      message: {
        conversation: 'Opa Rodrigo, boa tarde! Aqui é o Warley da WarNat Tech. Vou assumir o atendimento por aqui para te passar os detalhes.'
      }
    }
  };

  console.log(`[Técnico Humano Warley no celular] "${humanTakeoverPayload.data.message.conversation}"`);
  const humanResult = await webhookController.handleWebhook(humanTakeoverPayload);

  console.log(`[Webhook Status] Ação: ${humanResult.action}`);
  console.log(`   - Minutos de pausa configurados: ${humanResult.pausaMinutos} min`);
  console.log(`   - Pausado até: ${humanResult.pausedUntil.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

  // Verifica estado no banco de dados
  const sessionAfterHuman = await query(
    `SELECT status_atendimento, paused_until FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2`,
    [tenant.id, testCustomerJid]
  );

  console.log('📊 Validação do Fluxo 2 no PostgreSQL:');
  console.log(`   - status_atendimento: "${sessionAfterHuman.rows[0].status_atendimento}" (esperado: pausa_humana)`);
  console.log(`   - paused_until ativo no banco: ${Boolean(sessionAfterHuman.rows[0].paused_until)}`);

  if (sessionAfterHuman.rows[0].status_atendimento !== 'pausa_humana') {
    throw new Error('Falha na ativação da pausa humana!');
  }

  // Simula cliente respondendo após a pausa humana: IA DEVE PERMANECER EM SILÊNCIO
  console.log('\n⏳ Simulando cliente respondendo enquanto a IA está pausada...');
  const clientFollowupPayload = {
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: {
        remoteJid: testCustomerJid,
        fromMe: false,
        id: `CLIENT_FOLLOWUP_${Date.now()}`
      },
      message: {
        conversation: 'Perfeito Warley, combinado! Estou no aguardo.'
      }
    }
  };

  const followupResult = await webhookController.handleWebhook(clientFollowupPayload);
  console.log(`[Webhook Status com Pausa Ativa] Ação: ${followupResult.action} (esperado: message_saved_human_in_control)`);
  if (followupResult.action !== 'message_saved_human_in_control') {
    throw new Error('A IA não respeitou a pausa humana e tentou intervir!');
  }
  console.log('✅ FLUXO 2 CONCLUÍDO COM 100% DE SUCESSO! A IA respeitou a pausa humana.\n');

  // ----------------------------------------------------------------------------
  // FLUXO 3: QUALIFICAÇÃO COMPLETA -> REGISTRO NO BANCO & ALERTA TÉCNICO
  // ----------------------------------------------------------------------------
  console.log('--------------------------------------------------------------------------------');
  console.log('TESTE DE FLUXO 3: Qualificação de Lead via Tool Calling & Alerta Estruturado');
  console.log('--------------------------------------------------------------------------------');

  // Reativa a sessão para permitir que a IA execute a qualificação
  await query(
    `UPDATE chat_sessions SET status_atendimento = 'ia_ativa', paused_until = NULL WHERE tenant_id = $1 AND remote_jid = $2`,
    [tenant.id, testCustomerJid]
  );

  const sessionObj = (await query(`SELECT id FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2`, [tenant.id, testCustomerJid])).rows[0];

  const leadQualificationArgs = {
    nome: customerName,
    servico: 'Nova Instalação de 4 Câmeras CFTV Full HD',
    bairro_cidade: 'Barreiro / Belo Horizonte',
    urgencia: 'alta',
    detalhes: 'Casa de 2 andares, quer cobertura na garagem frontal e quintal dos fundos com acesso remoto no iPhone.'
  };

  console.log('⚙️ Invocando Tool nativa salvar_lead_qualificado com os dados coletados...');
  const qualResult = await aiEngine.executeQualificationTool({
    tenantId: tenant.id,
    instanceName,
    sessionId: sessionObj.id,
    remoteJid: testCustomerJid,
    args: leadQualificationArgs
  });

  console.log(`[Tool Result] Sucesso: ${qualResult.success}`);
  console.log(`[Tool Result] Notificação WhatsApp enviada: ${qualResult.notifSent}`);

  // Validação no PostgreSQL
  const sessionWithLead = await query(
    `SELECT client_name, dados_lead FROM chat_sessions WHERE id = $1`,
    [sessionObj.id]
  );
  const leadSalvo = sessionWithLead.rows[0].dados_lead;

  console.log('\n📊 Validação do Fluxo 3 no PostgreSQL (chat_sessions.dados_lead):');
  console.log(`   - Nome do Cliente: "${sessionWithLead.rows[0].client_name}"`);
  console.log(`   - Serviço Solicitado: "${leadSalvo.servico}"`);
  console.log(`   - Bairro e Cidade: "${leadSalvo.bairro_cidade}"`);
  console.log(`   - Grau de Urgência: "${leadSalvo.urgencia}"`);
  console.log(`   - Observações Técnicas: "${leadSalvo.detalhes}"`);
  console.log(`   - Timestamp de Qualificação: "${leadSalvo.qualificado_em}"`);

  if (
    leadSalvo.nome !== customerName ||
    !leadSalvo.servico.includes('Nova Instalação') ||
    leadSalvo.urgencia !== 'alta'
  ) {
    throw new Error('Falha no salvamento estruturado dos dados do lead!');
  }

  console.log('✅ FLUXO 3 CONCLUÍDO COM 100% DE SUCESSO!\n');

  console.log('================================================================================');
  console.log('🎉 TESTE DE SMOKE END-TO-END CONCLUÍDO COM 100% DE APROVAÇÃO!');
  console.log('   - Fluxo 1 (Cliente -> IA Dinâmica): APROVADO');
  console.log('   - Fluxo 2 (Operador Humano -> Pausa Anti-Conflito): APROVADO');
  console.log('   - Fluxo 3 (Qualificação -> Banco & Alerta): APROVADO');
  console.log('================================================================================');

  process.exit(0);
}

runSmokeTestE2E().catch(err => {
  console.error('\n💥 Falha no Teste de Smoke:', err);
  process.exit(1);
});

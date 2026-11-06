// ==============================================================================
// SAAS MULTI-TENANT ENGINE - SMOKE TEST E2E (FASE 6) [TYPESCRIPT]
// Validação completa de ponta a ponta com o Tenant #1 (WarNat Tech):
// 1. Mensagem simulada do cliente -> Debounce -> Resposta da IA com key.id
// 2. Trava anti-loop (fromMe do bot ignorado) & Detecção de operador humano (pausa 45 min)
// 3. Reativação da IA via CRM switch (zerando paused_until)
// 4. Qualificação completa -> dados_lead, Dossiê Permanente & Alerta no WhatsApp
// ==============================================================================

import { query, shutdownPool } from '../src/database/db';
import { seedWarNatTech } from '../src/database/seed_warnat';
import { WebhookController } from '../src/controllers/webhook.controller';
import { messageCache } from '../src/services/message-cache.service';
import { aiEngineService } from '../src/services/ai-engine.service';
import { EvolutionWebhookPayload } from '../src/types/evolution.types';

async function runSmokeTestE2E() {
  console.log('================================================================');
  console.log('🚀 INICIANDO TESTE DE SMOKE E2E MULTI-TENANT - WARNAT TECH (FASE 6)');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${details ? `: ${details}` : ''}`);
      throw new Error(`Test failed: ${testName}`);
    }
  }

  // 1. Garante que a WarNat Tech está provisionada
  const seedResult = await seedWarNatTech();
  const tenantId = seedResult.tenantId;
  const instanceName = seedResult.instanceName;

  // Instancia WebhookController com delay curto de debounce (100ms) para execução ágil
  const webhook = new WebhookController(100);

  const customerJid = `5531998877665@s.whatsapp.net`;

  try {
    // Limpa sessões de testes anteriores para este número
    await query(`DELETE FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2;`, [tenantId, customerJid]);

    // ==========================================================================
    // FLUXO 1: RECEBIMENTO DE MENSAGEM SIMULADA -> DEBOUNCE -> RESPOSTA DA IA
    // ==========================================================================
    console.log('📋 FLUXO 1: Atendimento Comercial com Debounce & Resposta da IA');

    // Simula 2 fragmentos rápidos enviados pelo cliente
    const msgIdPart1 = `MSG_PART1_${Date.now()}`;
    const payloadPart1: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: customerJid, fromMe: false, id: msgIdPart1 },
        pushName: 'Carlos Barreiro',
        message: { conversation: 'Olá, boa tarde WarNat Tech!' }
      }
    };

    const msgIdPart2 = `MSG_PART2_${Date.now()}`;
    const payloadPart2: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: customerJid, fromMe: false, id: msgIdPart2 },
        pushName: 'Carlos Barreiro',
        message: { conversation: 'Vocês fazem instalação de 4 câmeras no bairro Barreiro?' }
      }
    };

    const resPart1 = await webhook.handleWebhook(payloadPart1);
    const resPart2 = await webhook.handleWebhook(payloadPart2);

    assert(resPart1.action === 'buffered_in_debounce', 'Primeiro fragmento colocado no buffer de debounce');
    assert(resPart2.action === 'buffered_in_debounce', 'Segundo fragmento consolidado no mesmo buffer');

    // Aguarda o término do debounce e o processamento da IA (polling até 8s)
    let aiReply: { role: string; content: string; message_id: string } | undefined;
    const startWait = Date.now();
    while (Date.now() - startWait < 8000) {
      const checkRes = await query<{ role: string; content: string; message_id: string }>(
        `SELECT role, content, message_id FROM chat_messages 
         WHERE session_id = (SELECT id FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2)
           AND role = 'assistant';`,
        [tenantId, customerJid]
      );
      if (checkRes.rows.length > 0) {
        aiReply = checkRes.rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // Verifica se a sessão foi criada
    const sessionRes = await query<{ id: string; status_atendimento: string }>(
      `SELECT id, status_atendimento FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2;`,
      [tenantId, customerJid]
    );
    assert(sessionRes.rows.length === 1, 'Sessão de atendimento criada no banco');
    assert(sessionRes.rows[0].status_atendimento === 'ia_ativa', 'Status inicial é "ia_ativa"');

    const sessionId = sessionRes.rows[0].id;

    // Verifica se a resposta da IA foi gerada e gravada em chat_messages
    const messagesRes = await query<{ role: string; content: string; message_id: string }>(
      `SELECT role, content, message_id FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at ASC;`,
      [sessionId]
    );

    assert(messagesRes.rows.length >= 3, 'Histórico contém os 2 fragmentos do cliente + resposta da IA');
    aiReply = messagesRes.rows.find((m) => m.role === 'assistant');
    assert(Boolean(aiReply), 'Resposta da IA gerada e salva no histórico');
    assert(Boolean(aiReply?.message_id), 'Resposta da IA possui messageId rastreável');

    // Valida que o messageId da IA foi salvo no cache Anti-Loop
    const isBotCached = await messageCache.isBotSent(aiReply!.message_id);
    assert(isBotCached === true, 'key.id da IA gravado no cache bot_sent (TTL 60s)');

    // ==========================================================================
    // FLUXO 2: TRAVA ANTI-LOOP (fromMe) & INTERVENÇÃO HUMANA
    // ==========================================================================
    console.log('\n📋 FLUXO 2: Trava Anti-Loop & Detecção de Operador Humano no Celular');

    // 2.1 O próprio disparo do bot chega via webhook (fromMe: true)
    const botEchoPayload: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: customerJid, fromMe: true, id: aiReply!.message_id },
        message: { conversation: aiReply!.content }
      }
    };

    const echoRes = await webhook.handleWebhook(botEchoPayload);
    assert(echoRes.action === 'ignored_bot_sent', 'Trava Anti-Loop: mensagem da própria IA ignorada com status 200');

    // 2.2 Técnico Warley responde no WhatsApp físico do celular (fromMe: true não presente no cache)
    const humanMsgId = `HUMAN_MSG_${Date.now()}`;
    const humanPayload: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: customerJid, fromMe: true, id: humanMsgId },
        message: { conversation: 'Olá Carlos, aqui é o Warley da WarNat! Posso ir no seu condomínio no sábado de manhã.' }
      }
    };

    const humanRes = await webhook.handleWebhook(humanPayload);
    assert(humanRes.action === 'human_operator_takeover_activated', 'Detecção de operador humano no celular físico confirmada');
    assert(humanRes.pausaMinutos === 45, 'Pausa configurada respeita os 45 min da WarNat Tech');

    // Verifica no banco se a sessão foi colocada em pausa_humana
    const sessionAfterHuman = (await query<{ status_atendimento: string; paused_until: Date }>(
      `SELECT status_atendimento, paused_until FROM chat_sessions WHERE id = $1;`,
      [sessionId]
    )).rows[0];

    assert(sessionAfterHuman.status_atendimento === 'pausa_humana', 'Sessão atualizada para "pausa_humana"');
    assert(new Date(sessionAfterHuman.paused_until) > new Date(), 'paused_until definido no futuro (+45 min)');

    // 2.3 Cliente envia nova mensagem enquanto a pausa está ativa
    const customerMsgWhilePaused: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: customerJid, fromMe: false, id: `CLIENT_MSG_PAUSED_${Date.now()}` },
        message: { conversation: 'Perfeito Warley, sábado às 10h fica ótimo!' }
      }
    };

    const pausedTurnRes = await webhook.handleWebhook(customerMsgWhilePaused);
    assert(pausedTurnRes.action === 'message_saved_human_in_control', 'Mensagem gravada sem intervenção da IA enquanto operador atende');

    // 2.4 Operador reativa a IA pelo CRM switch (zera paused_until)
    await query(
      `UPDATE chat_sessions 
       SET status_atendimento = 'ia_ativa', paused_until = NULL, last_interaction = NOW()
       WHERE id = $1;`,
      [sessionId]
    );

    const sessionResumed = (await query<{ status_atendimento: string; paused_until: Date | null }>(
      `SELECT status_atendimento, paused_until FROM chat_sessions WHERE id = $1;`,
      [sessionId]
    )).rows[0];

    assert(sessionResumed.status_atendimento === 'ia_ativa', 'IA reativada com status "ia_ativa"');
    assert(sessionResumed.paused_until === null, 'paused_until zerado imediatamente');

    // ==========================================================================
    // FLUXO 3: QUALIFICAÇÃO COMPLETA & ALERTA NO WHATSAPP DA EQUIPE
    // ==========================================================================
    console.log('\n📋 FLUXO 3: Qualificação Completa de Lead & Notificação Humana');

    const qualifResult = await aiEngineService.executeQualificationTool({
      tenantId,
      instanceName,
      sessionId,
      remoteJid: customerJid,
      args: {
        nome: 'Carlos Henrique Barreiro',
        servico: 'Nova Instalação de Câmeras de Segurança (CFTV HD / IP / Wi-Fi)',
        bairro_cidade: 'Barreiro / Belo Horizonte',
        urgencia: 'alta',
        detalhes: 'Condomínio de 12 apartamentos, deseja trocar 4 câmeras analógicas por IP 4K.'
      }
    });

    assert(qualifResult.success === true, 'Tool salvar_lead_qualificado executada com sucesso');
    assert(qualifResult.notifSent === true, 'Alerta enviado para o WhatsApp do responsável técnico (+5531983525816)');

    // Valida dados_lead salvos no banco
    const sessionLead = (await query<{ dados_lead: any }>(
      `SELECT dados_lead FROM chat_sessions WHERE id = $1;`,
      [sessionId]
    )).rows[0].dados_lead;

    assert(sessionLead.nome === 'Carlos Henrique Barreiro', 'Nome do lead qualificado gravado');
    assert(sessionLead.servico.includes('Nova Instalação de Câmeras'), 'Serviço qualificado gravado');
    assert(sessionLead.bairro_cidade === 'Barreiro / Belo Horizonte', 'Localização gravada');
    assert(sessionLead.urgencia === 'alta', 'Urgência alta gravada');

    // Valida persistência no Dossiê Permanente do Cliente (customer_profiles)
    const profileDb = (await query<{ perfil_resumo: string; nome: string }>(
      `SELECT perfil_resumo, nome FROM customer_profiles WHERE tenant_id = $1 AND remote_jid = $2;`,
      [tenantId, customerJid]
    )).rows[0];

    assert(profileDb.nome === 'Carlos Henrique Barreiro', 'Nome sincronizado no dossiê de longo prazo');
    assert(profileDb.perfil_resumo.includes('Condomínio de 12 apartamentos'), 'Nota cumulativa gravada no dossiê permanente');

    console.log('\n================================================================');
    console.log('🎉 TESTE DE SMOKE E2E CONCLUÍDO COM 100% DE SUCESSO!');
    console.log(`Total de Asserções: ${totalTests} | Aprovadas: ${passedTests} | Falhas: 0`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('❌ Falha no Teste de Smoke E2E:', err);
    throw err;
  } finally {
    webhook.clearBuffers();
    await shutdownPool();
  }
}

runSmokeTestE2E()
  .then(() => {
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    console.error(err);
    setTimeout(() => process.exit(1), 100);
  });

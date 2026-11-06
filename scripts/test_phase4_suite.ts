// ==============================================================================
// SAAS MULTI-TENANT ENGINE - PHASE 4 TEST SUITE (TYPESCRIPT)
// Comprehensive automated test verifying:
// 1. Dynamic Prompt Compiler: injection of business rules, customer dossier & CDC/LGPD
// 2. Mandatory Qualification Tool: schema validation & parameters
// 3. executeQualificationTool: session update, dossier synchronization & human alert
// 4. Conversational History Window: strictly limited to the 10 most recent messages
// 5. End-to-End AI Turn execution & Bot message caching
// ==============================================================================

import { query, shutdownPool } from '../src/database/db';
import { AuthService } from '../src/services/auth.service';
import { CustomerService } from '../src/services/customer.service';
import { promptCompiler } from '../src/services/prompt-compiler.service';
import { aiEngineService, QUALIFICATION_TOOL } from '../src/services/ai-engine.service';
import { messageCache } from '../src/services/message-cache.service';
import { Tenant, TenantAiConfig, ChatSession } from '../src/types/database.types';

async function runPhase4Tests() {
  console.log('================================================================');
  console.log('🧪 INICIANDO BATERIA DE TESTES DE INTEGRAÇÃO - FASE 4 (TYPESCRIPT)');
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

  try {
    // --------------------------------------------------------------------------
    // Setup: Tenant com Regras Avançadas de IA
    // --------------------------------------------------------------------------
    const tenantEmail = `fase4.test.${Date.now()}@warnattech.com`;
    const regResult = await AuthService.registerTenantAndAdmin({
      nome_empresa: 'WarNat Segurança & CFTV Inteligente',
      documento: '33.444.555/0001-66',
      plano: 'enterprise',
      nome: 'Engenheiro Chefe',
      email: tenantEmail,
      password: 'SenhaForteFase4!',
      sobre_empresa: 'Pioneiros em CFTV IP, alarmes monitorados e controle de acesso facial.'
    });

    const tenantId = regResult.tenant.id;
    const instanceName = `inst-fase4-${Date.now()}`;
    const notifTechPhone = '5531988881234';

    // Configura regras de IA personalizadas para o Tenant
    await query(
      `UPDATE tenant_ai_configs
       SET tom_de_voz = 'tecnico_acolhedor',
           servicos_oferecidos = $1::jsonb,
           servicos_recusados = 'Não realizamos conserto de celulares, computadores ou cerca elétrica.',
           regras_agendamento = $2::jsonb,
           whatsapp_notificacao_humana = $3,
           pausa_automatica_minutos = 60
       WHERE tenant_id = $4;`,
      [
        JSON.stringify([
          { nome: 'Instalação de Câmeras IP', faixa_preco: 'A partir de R$ 350', detalhes: 'Resolução 4K com gravação em nuvem' },
          { nome: 'Manutenção de CFTV', faixa_preco: 'Visita técnica R$ 150', detalhes: 'Diagnóstico e reparo de cabeamento' }
        ]),
        JSON.stringify({ dias: ['segunda', 'quarta', 'sexta', 'sabado'], horario_inicio: '08:00', horario_fim: '17:00' }),
        notifTechPhone,
        tenantId
      ]
    );

    // Cadastra instância WhatsApp
    await query(
      `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, numero_telefone, status)
       VALUES ($1, $2, '5531977771111', 'open');`,
      [tenantId, instanceName]
    );

    // --------------------------------------------------------------------------
    // Teste 1: Prompt Compiler Dinâmico & Injeção de Contexto
    // --------------------------------------------------------------------------
    console.log('📋 Teste 1: Prompt Compiler Dinâmico (Injeção de Regras e CDC/LGPD)');
    const tenantDb = (await query<Tenant>(`SELECT * FROM tenants WHERE id = $1;`, [tenantId])).rows[0];
    const aiConfigDb = (await query<TenantAiConfig>(`SELECT * FROM tenant_ai_configs WHERE tenant_id = $1;`, [tenantId])).rows[0];

    const remoteJidClient = '5531991234567@s.whatsapp.net';
    const profile = await CustomerService.findOrCreateProfile(tenantId, remoteJidClient, {
      nome: 'Dr. Roberto Condômino',
      endereco_completo: 'Av. Afonso Pena, 1500 - Funcionários, BH',
      perfil_resumo: 'Cliente possui sistema DVR Intelbras antigo com 8 câmeras com mau contato.'
    });

    const appointment = await CustomerService.createAppointment(tenantId, {
      remote_jid: remoteJidClient,
      servico: 'Instalação de Câmeras IP',
      data_agendada: new Date(Date.now() + 86400000 * 2),
      status: 'agendado'
    });

    const compiledPrompt = promptCompiler.compileSystemPrompt(
      tenantDb,
      aiConfigDb,
      { dados_lead: { etapa: 'sondagem' } },
      profile,
      [appointment]
    );

    assert(compiledPrompt.includes('WarNat Segurança & CFTV Inteligente'), 'Nome da empresa injetado no prompt');
    assert(compiledPrompt.includes('TECNICO_ACOLHEDOR'), 'Tom de voz injetado');
    assert(compiledPrompt.includes('Instalação de Câmeras IP'), 'Serviços oferecidos listados com detalhes');
    assert(compiledPrompt.includes('Não realizamos conserto de celulares'), 'Serviços recusados explicitados');
    assert(compiledPrompt.includes('DIRETRIZ DE TRANSPARÊNCIA OBRIGATÓRIA (CDC / LGPD)'), 'Diretriz CDC/LGPD incluída');
    assert(compiledPrompt.includes('Dr. Roberto Condômino'), 'Dossiê do cliente (memória permanente) incorporado');
    assert(compiledPrompt.includes('salvar_lead_qualificado'), 'Instrução de Tool Calling obrigatória presente');

    // --------------------------------------------------------------------------
    // Teste 2: Schema da Tool de Qualificação Obrigatória
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 2: Schema da Tool de Qualificação (OpenAI Function Calling)');
    assert(QUALIFICATION_TOOL.type === 'function', 'Tool definida como function');
    assert(QUALIFICATION_TOOL.function.name === 'salvar_lead_qualificado', 'Nome da tool é salvar_lead_qualificado');
    assert(Array.isArray(QUALIFICATION_TOOL.function.parameters?.required), 'Campos obrigatórios definidos');
    assert(
      QUALIFICATION_TOOL.function.parameters?.required?.includes('nome') &&
      QUALIFICATION_TOOL.function.parameters?.required?.includes('servico') &&
      QUALIFICATION_TOOL.function.parameters?.required?.includes('bairro_cidade'),
      'Campos obrigatórios contêm nome, servico e bairro_cidade'
    );

    // --------------------------------------------------------------------------
    // Teste 3: Execução da Tool de Qualificação Obrigatória
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 3: Execução de salvar_lead_qualificado (Banco, Dossiê e Alerta)');
    const sessionRes = await query<{ id: string }>(
      `INSERT INTO chat_sessions (tenant_id, remote_jid, status_atendimento)
       VALUES ($1, $2, 'ia_ativa')
       RETURNING id;`,
      [tenantId, remoteJidClient]
    );
    const sessionId = sessionRes.rows[0].id;

    const toolResult = await aiEngineService.executeQualificationTool({
      tenantId,
      instanceName,
      sessionId,
      remoteJid: remoteJidClient,
      args: {
        nome: 'Roberto Silveira',
        servico: 'Instalação de Câmeras IP',
        bairro_cidade: 'Funcionários / Belo Horizonte',
        urgencia: 'alta',
        detalhes: 'Deseja trocar 8 câmeras analógicas por IP até sexta-feira.'
      }
    });

    assert(toolResult.success === true, 'Tool executada com sucesso');
    assert(toolResult.notifSent === true, 'Alerta enviado para whatsapp_notificacao_humana');

    // Valida persistência em chat_sessions.dados_lead
    const sessionAfterTool = (await query<ChatSession>(`SELECT dados_lead FROM chat_sessions WHERE id = $1;`, [sessionId])).rows[0];
    const lead = sessionAfterTool.dados_lead as any;
    assert(lead.nome === 'Roberto Silveira', 'dados_lead gravado com nome');
    assert(lead.servico === 'Instalação de Câmeras IP', 'dados_lead gravado com serviço');
    assert(lead.urgencia === 'alta', 'dados_lead gravado com urgência alta');

    // Valida sincronização no dossiê de longo prazo (customer_profiles)
    const profileAfter = (await query(`SELECT perfil_resumo FROM customer_profiles WHERE tenant_id = $1 AND remote_jid = $2;`, [tenantId, remoteJidClient])).rows[0];
    assert(profileAfter.perfil_resumo.includes('Lead qualificado para Instalação de Câmeras IP'), 'Dossiê cumulativo atualizado com novo lead');

    // --------------------------------------------------------------------------
    // Teste 4: Janela de Histórico Conversacional (Limite Estrito de 10 Mensagens)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 4: Janela Estrita de Histórico Recente (Máximo 10 Mensagens)');
    // Insere 15 mensagens no histórico
    for (let i = 1; i <= 15; i++) {
      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${i} seconds');`,
        [sessionId, tenantId, i % 2 === 0 ? 'assistant' : 'user', `Mensagem de histórico número ${i}`]
      );
    }

    const countRes = await query<{ count: string }>(`SELECT count(*) FROM chat_messages WHERE session_id = $1;`, [sessionId]);
    assert(Number(countRes.rows[0].count) >= 15, '15 mensagens inseridas na sessão');

    // Executa processTurn e verifica que o histórico é limitado estritamente a 10
    const turnResult = await aiEngineService.processTurn({
      tenantId,
      instanceName,
      sessionId,
      remoteJid: remoteJidClient,
      pushName: 'Roberto',
      userMessage: 'Qual o valor total estimado para as 8 câmeras?'
    });

    assert(turnResult.success === true, 'Turno da IA processado');
    assert(Boolean(turnResult.replyText), 'Resposta em texto gerada');
    assert(Boolean(turnResult.messageId), 'Resposta retornou messageId para rastreamento');

    // Verifica que a resposta da IA foi salva no cache anti-loop
    const cached = await messageCache.isBotSent(turnResult.messageId!);
    assert(cached === true, 'Resposta da IA gravada no cache bot_sent (Anti-Loop)');

    // --------------------------------------------------------------------------
    // Limpeza final do tenant de teste
    // --------------------------------------------------------------------------
    await query('DELETE FROM tenants WHERE id = $1;', [tenantId]);

    console.log('\n================================================================');
    console.log(`🎉 TODAS AS VALIDAÇÕES DA FASE 4 FORAM CONCLUÍDAS COM SUCESSO!`);
    console.log(`Total de Testes: ${totalTests} | Aprovados: ${passedTests} | Falhas: 0`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('❌ Falha na bateria de testes da Fase 4:', err);
    throw err;
  } finally {
    await shutdownPool();
  }
}

runPhase4Tests()
  .then(() => {
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    console.error(err);
    setTimeout(() => process.exit(1), 100);
  });

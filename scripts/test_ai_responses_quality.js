// ==============================================================================
// Teste de Qualidade das Respostas da IA (ChatGPT gpt-4o-mini) & Funil Comercial
// Valida Persona, 4 Passos do Funil, Anti-Robótico, Ferramentas e OpenAI Real
// ==============================================================================

const path = require('path');
const fs = require('fs');
const { query } = require('../database/db');
const promptCompiler = require('../services/prompt-compiler.service');
const aiEngine = require('../services/ai-engine.service');

async function runTestSuite() {
  console.log('====================================================================');
  console.log('🚀 INICIANDO BATERIA DE TESTES DE QUALIDADE DAS RESPOSTAS DA IA');
  console.log('====================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // 1. Obter tenant WarNat Tech do banco
  const tenantRes = await query(`SELECT * FROM tenants WHERE nome_empresa = 'WarNat Tech' LIMIT 1`);
  if (tenantRes.rowCount === 0) {
    console.error('❌ Tenant WarNat Tech não encontrado!');
    process.exit(1);
  }
  const tenant = tenantRes.rows[0];

  const aiConfigRes = await query(`SELECT * FROM tenant_ai_configs WHERE tenant_id = $1`, [tenant.id]);
  const aiConfig = aiConfigRes.rows[0];

  console.log(`[Config] Tenant: ${tenant.nome_empresa} (${tenant.id})`);
  console.log(`[Config] Assistente: ${aiConfig.nome_assistente} | Técnico: ${aiConfig.responsavel_tecnico}`);
  console.log(`[Config] Região: ${aiConfig.regiao_atendimento} | Taxa Manutenção: R$ ${aiConfig.taxa_manutencao_reais}\n`);

  // ----------------------------------------------------------------------------
  // TESTE 1: Compilação do Prompt do Sistema (Persona e Regras)
  // ----------------------------------------------------------------------------
  console.log('--- TESTE 1: Validação Estrutural do System Prompt ---');
  const compiledPrompt = promptCompiler.compileSystemPrompt(tenant, aiConfig);

  assert(compiledPrompt.includes('Nat'), 'Contém nome da assistente Nat');
  assert(compiledPrompt.includes('Warley Santos'), 'Contém responsável técnico Warley Santos');
  assert(compiledPrompt.includes('Belo Horizonte, Barreiro'), 'Contém região de atendimento Barreiro/BH');
  assert(compiledPrompt.includes('140,00'), 'Contém a taxa de manutenção de R$ 140,00');
  assert(compiledPrompt.includes('PASSO 1'), 'Contém diretriz explícita do PASSO 1');
  assert(compiledPrompt.includes('PASSO 2'), 'Contém diretriz explícita do PASSO 2 (Nova Instalação)');
  assert(compiledPrompt.includes('PASSO 3'), 'Contém diretriz explícita do PASSO 3 (Manutenção)');
  assert(compiledPrompt.includes('PASSO 4'), 'Contém diretriz explícita do PASSO 4 (Recusa)');
  assert(compiledPrompt.includes('Parece que você não mencionou nada específico'), 'Lista frases proibidas robóticas');
  assert(compiledPrompt.includes('Como posso ajudar você hoje'), 'Proíbe "Como posso ajudar você hoje?"');
  assert(compiledPrompt.includes('REGRA CRÍTICA DA PRIMEIRA MENSAGEM'), 'Contém regra obrigatória da primeira mensagem');
  assert(compiledPrompt.includes('salvar_lead_qualificado'), 'Exige qualificação e tool calling');
  console.log('');

  // ----------------------------------------------------------------------------
  // TESTE 2: Cenário A - Pergunta Genérica de Preço / Visita (PASSO 1)
  // O cliente pergunta preço sem dizer se tem câmeras ou quer novas.
  // ----------------------------------------------------------------------------
  console.log('--- TESTE 2: Cenário A - Pergunta Genérica de Preço / Visita (Primeira Mensagem) ---');
  console.log('Cliente: "Quanto custa a visita técnica?"');

  const scenarioAMessages = [
    { role: 'system', content: compiledPrompt },
    {
      role: 'system',
      content: `LEMBRETE OBRIGATÓRIO (PRIMEIRA MENSAGEM): Esta é a sua primeira mensagem neste atendimento. Você DEVE se apresentar como a Nat, assistente virtual da ${tenant.nome_empresa || 'WarNat Tech'}, e avisar com simpatia que se o cliente preferir pode solicitar o atendimento por um atendente/especialista humano a qualquer momento.`
    },
    { role: 'user', content: 'Quanto custa a visita técnica?' }
  ];

  const respA = await aiEngine.openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: scenarioAMessages,
    tools: require('../services/ai-engine.service').TOOLS_DEFINITIONS,
    tool_choice: 'auto',
    temperature: 0.3
  });

  const replyA = respA.choices[0].message.content || '';
  console.log(`Resposta IA:\n"${replyA}"\n`);

  assert(
    replyA.includes('Nat'),
    'Apresenta-se como Nat na primeira mensagem'
  );
  assert(
    replyA.toLowerCase().includes('humano') || replyA.toLowerCase().includes('atendente') || replyA.toLowerCase().includes('agente') || replyA.toLowerCase().includes('especialista'),
    'Informa opção de atendimento por atendente/agente humano'
  );
  assert(
    replyA.toLowerCase().includes('nova instalação') || replyA.toLowerCase().includes('nova instalacao'),
    'Pergunta se é nova instalação'
  );
  assert(
    replyA.toLowerCase().includes('manutenção') || replyA.toLowerCase().includes('manutencao') || replyA.toLowerCase().includes('conserto'),
    'Pergunta se é manutenção ou conserto de câmeras existentes'
  );
  assert(
    !replyA.toLowerCase().includes('100% gratuita') && !replyA.toLowerCase().includes('gratuita e sem compromisso'),
    'NÃO assume gratuidade antes da identificação do cliente'
  );
  assert(
    !replyA.includes('Como posso ajudar você hoje?') && !replyA.includes('Prezado cliente'),
    'Não usa frases robóticas proibidas'
  );
  console.log('');

  // ----------------------------------------------------------------------------
  // TESTE 3: Cenário B - Cliente Confirma Nova Instalação (PASSO 2)
  // ----------------------------------------------------------------------------
  console.log('--- TESTE 3: Cenário B - Cliente Confirma Nova Instalação ---');
  console.log('Cliente: "É para uma nova instalação de 4 câmeras no meu comércio"');

  const scenarioBMessages = [
    { role: 'system', content: compiledPrompt },
    { role: 'user', content: 'Quanto custa a visita técnica?' },
    { role: 'assistant', content: replyA },
    { role: 'user', content: 'É para uma nova instalação de 4 câmeras no meu comércio' }
  ];

  let respB = await aiEngine.openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: scenarioBMessages,
    tools: require('../services/ai-engine.service').TOOLS_DEFINITIONS,
    tool_choice: 'auto',
    temperature: 0.3
  });

  let replyB = '';
  if (respB.choices[0].message.tool_calls) {
    const tc = respB.choices[0].message.tool_calls[0];
    console.log(`  -> IA disparou ferramenta: ${tc.function.name}`);
    assert(
      tc.function.name === 'get_available_calendar_slots' || tc.function.name === 'salvar_lead_qualificado',
      'Disparou ferramenta de consulta de horários ou lead'
    );

    // Simula retorno de horários da agenda
    const mockSlotsResult = {
      success: true,
      slots: [
        { date: '2026-11-07', dayOfWeek: 'Sábado', time: '10:00', description: 'Sábado (07/11) às 10:00' },
        { date: '2026-11-07', dayOfWeek: 'Sábado', time: '14:00', description: 'Sábado (07/11) às 14:00' }
      ]
    };

    scenarioBMessages.push(respB.choices[0].message);
    scenarioBMessages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify(mockSlotsResult)
    });

    const followUp = await aiEngine.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: scenarioBMessages,
      temperature: 0.3
    });
    replyB = followUp.choices[0].message.content || '';
  } else {
    replyB = respB.choices[0].message.content || '';
  }

  console.log(`Resposta IA:\n"${replyB}"\n`);
  assert(
    replyB.toLowerCase().includes('gratuita') || replyB.toLowerCase().includes('sem compromisso'),
    'Informa que para nova instalação a visita é gratuita e sem compromisso'
  );
  assert(
    replyB.toLowerCase().includes('warley') || replyB.toLowerCase().includes('pontos cegos') || replyB.toLowerCase().includes('cabeamento'),
    'Menciona o especialista Warley Santos ou avaliação de pontos cegos'
  );
  console.log('');

  // ----------------------------------------------------------------------------
  // TESTE 4: Cenário C - Cliente Confirma Manutenção (PASSO 3)
  // ----------------------------------------------------------------------------
  console.log('--- TESTE 4: Cenário C - Cliente Confirma Manutenção ---');
  console.log('Cliente: "Minhas câmeras pararam de gravar, acho que queimou"');

  const scenarioCMessages = [
    { role: 'system', content: compiledPrompt },
    { role: 'user', content: 'Minhas câmeras pararam de gravar, acho que queimou' }
  ];

  let respC = await aiEngine.openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: scenarioCMessages,
    tools: require('../services/ai-engine.service').TOOLS_DEFINITIONS,
    tool_choice: 'auto',
    temperature: 0.3
  });

  let replyC = '';
  if (respC.choices[0].message.tool_calls) {
    const tc = respC.choices[0].message.tool_calls[0];
    console.log(`  -> IA disparou ferramenta: ${tc.function.name}`);

    scenarioCMessages.push(respC.choices[0].message);
    scenarioCMessages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify({
        success: true,
        instruction: 'Atenção obrigatória para MANUTENÇÃO: informe com clareza a taxa de visita técnica de R$ 140,00 e que esse valor é 100% aproveitado e abatido no conserto, além de oferecer os 2 horários livres abaixo!',
        slots: [
          { date: '2026-11-07', dayOfWeek: 'Sábado', time: '10:00', description: 'Sábado (07/11) às 10:00' },
          { date: '2026-11-07', dayOfWeek: 'Sábado', time: '14:00', description: 'Sábado (07/11) às 14:00' }
        ]
      })
    });

    const followUp = await aiEngine.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: scenarioCMessages,
      temperature: 0.3
    });
    replyC = followUp.choices[0].message.content || '';
  } else {
    replyC = respC.choices[0].message.content || '';
  }

  console.log(`Resposta IA:\n"${replyC}"\n`);
  assert(
    replyC.includes('140') || replyC.includes('140,00'),
    'Apresenta com clareza a taxa de R$ 140,00'
  );
  assert(
    replyC.toLowerCase().includes('abatid') || replyC.toLowerCase().includes('aproveitad') || replyC.toLowerCase().includes('cobre o serviço') || replyC.toLowerCase().includes('não paga nenhum valor adicional'),
    'Explica que os R$ 140,00 são 100% aproveitados/abatidos no conserto'
  );
  console.log('');

  // ----------------------------------------------------------------------------
  // TESTE 5: Cenário D - Recusa de Serviço Fora do Escopo (PASSO 4)
  // ----------------------------------------------------------------------------
  console.log('--- TESTE 5: Cenário D - Recusa Fora do Escopo ---');
  console.log('Cliente: "Vocês fazem pintura de parede e buffet de festa?"');

  const scenarioDMessages = [
    { role: 'system', content: compiledPrompt },
    { role: 'user', content: 'Vocês fazem pintura de parede e buffet de festa?' }
  ];

  const respD = await aiEngine.openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: scenarioDMessages,
    temperature: 0.3
  });

  const replyD = respD.choices[0].message.content || '';
  console.log(`Resposta IA:\n"${replyD}"\n`);
  assert(
    replyD.toLowerCase().includes('não mexemos') || replyD.toLowerCase().includes('não atendemos') || replyD.toLowerCase().includes('não fazemos') || replyD.toLowerCase().includes('focados exclusivamente') || replyD.toLowerCase().includes('exclusivamente'),
    'Recusa com firmeza e simpatia serviços fora do escopo'
  );
  assert(
    replyD.toLowerCase().includes('câmeras') || replyD.toLowerCase().includes('cftv') || replyD.toLowerCase().includes('segurança'),
    'Reafirma especialidade em câmeras de segurança e CFTV'
  );
  console.log('');

  // ----------------------------------------------------------------------------
  // TESTE 6: Teste End-to-End no Banco via aiEngine.processTurn
  // ----------------------------------------------------------------------------
  console.log('--- TESTE 6: Integração Completa com Banco e Sessão ---');
  const testJid = '5531999998888@s.whatsapp.net';

  // Cria ou limpa sessão de teste
  await query(`DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE remote_jid = $1)`, [testJid]);
  await query(`DELETE FROM appointments WHERE remote_jid = $1`, [testJid]);
  await query(`DELETE FROM chat_sessions WHERE remote_jid = $1`, [testJid]);

  const sessRes = await query(
    `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, status_atendimento, last_interaction)
     VALUES ($1, $2, 'Cliente Teste E2E', 'ia_ativa', now())
     RETURNING id`,
    [tenant.id, testJid]
  );
  const testSessionId = sessRes.rows[0].id;

  // Mock do evolutionService para capturar o envio sem disparar para a API física
  const evolutionService = require('../services/evolution.service');
  let capturedMessage = '';
  evolutionService.sendTextMessage = async (instance, to, text) => {
    capturedMessage = text;
    return { success: true, messageId: `msg-mock-${Date.now()}` };
  };

  const turnRes = await aiEngine.processTurn({
    tenantId: tenant.id,
    instanceName: 'warnat-tech',
    sessionId: testSessionId,
    remoteJid: testJid,
    pushName: 'Warley',
    userMessage: 'Olá, gostaria de saber se vocês fazem visita técnica para novas câmeras?'
  });

  assert(turnRes.success === true, 'ProcessTurn executado com sucesso');
  assert(capturedMessage.length > 0, 'Mensagem enviada capturada pelo canal do WhatsApp');
  assert(
    capturedMessage.toLowerCase().includes('gratuita') || capturedMessage.toLowerCase().includes('warley') || capturedMessage.toLowerCase().includes('câmeras'),
    'Resposta gerada pelo ChatGPT contém a essência consultiva da WarNat Tech'
  );

  console.log(`Resposta capturada no Turn:\n"${capturedMessage}"\n`);

  // ----------------------------------------------------------------------------
  // TESTE 7: Consulta ao Histórico do Contato & Cancelamento de Agendamento
  // ----------------------------------------------------------------------------
  console.log('--- TESTE 7: Consulta ao Histórico & Cancelamento de Agendamento ---');
  // 1. Cadastra agendamento ativo prévio para o cliente
  const apptDateTz = new Date('2026-11-07T10:00:00-03:00');
  await query(
    `INSERT INTO appointments (tenant_id, remote_jid, servico, data_agendada, status, endereco)
     VALUES ($1, $2, 'Instalação de Câmeras CFTV', $3, 'agendado', 'Rua das Flores, 123 - Barreiro')`,
    [tenant.id, testJid, apptDateTz]
  );

  let cancelCapturedMessage = '';
  evolutionService.sendTextMessage = async (instance, to, text) => {
    cancelCapturedMessage = text;
    return { success: true, messageId: `msg-cancel-${Date.now()}` };
  };

  const cancelTurnRes = await aiEngine.processTurn({
    tenantId: tenant.id,
    instanceName: 'warnat-tech',
    sessionId: testSessionId,
    remoteJid: testJid,
    pushName: 'Warley',
    userMessage: 'Olá, infelizmente vou precisar cancelar meu agendamento de sábado.'
  });

  assert(cancelTurnRes.success === true, 'Turn de cancelamento executado com sucesso');

  // Verifica no banco de dados se o agendamento foi cancelado
  const checkCancelRes = await query(
    `SELECT status FROM appointments WHERE remote_jid = $1 ORDER BY created_at DESC LIMIT 1`,
    [testJid]
  );
  assert(checkCancelRes.rows[0].status === 'cancelado', 'Agendamento anterior cancelado com sucesso no PostgreSQL');
  console.log(`Resposta IA no Cancelamento:\n"${cancelCapturedMessage}"\n`);

  // ----------------------------------------------------------------------------
  // TESTE 8: Prevenção de Duplicidade de Agenda para o Mesmo Serviço
  // ----------------------------------------------------------------------------
  console.log('--- TESTE 8: Prevenção de Duplicidade de Agenda para o Mesmo Serviço ---');
  await query(`DELETE FROM appointments WHERE remote_jid = $1`, [testJid]);

  // Primeiro agendamento
  await aiEngine.executeBookAppointmentTool({
    tenantId: tenant.id,
    sessionId: testSessionId,
    remoteJid: testJid,
    pushName: 'Warley',
    args: {
      clientName: 'Warley Santos',
      date: '2026-11-07',
      time: '10:00',
      serviceType: 'Instalação de Câmeras CFTV',
      address: 'Barreiro'
    }
  });

  // Segundo agendamento tentando criar duplicata para o mesmo serviço (reagendamento para 14:00)
  await aiEngine.executeBookAppointmentTool({
    tenantId: tenant.id,
    sessionId: testSessionId,
    remoteJid: testJid,
    pushName: 'Warley',
    args: {
      clientName: 'Warley Santos',
      date: '2026-11-07',
      time: '14:00',
      serviceType: 'Instalação de Câmeras CFTV',
      address: 'Barreiro'
    }
  });

  const dupCheckRes = await query(
    `SELECT count(*) as total FROM appointments 
     WHERE remote_jid = $1 AND servico = 'Instalação de Câmeras CFTV' AND status = 'agendado'`,
    [testJid]
  );

  const totalActives = parseInt(dupCheckRes.rows[0].total, 10);
  assert(totalActives === 1, 'Evitou duplicidade: apenas 1 agendamento ativo mantido no banco');

  // Limpeza
  await query(`DELETE FROM appointments WHERE remote_jid = $1`, [testJid]);
  await query(`DELETE FROM chat_messages WHERE session_id = $1`, [testSessionId]);
  await query(`DELETE FROM chat_sessions WHERE id = $1`, [testSessionId]);

  console.log('====================================================================');
  console.log(`📊 RESULTADO FINAL: ${passed} PASSOU / ${failed} FALHOU`);
  console.log('====================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTestSuite().catch(err => {
  console.error('❌ Erro inesperado na bateria de testes:', err);
  process.exit(1);
});

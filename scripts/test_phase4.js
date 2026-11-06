const { query } = require('../database/db');
const promptCompiler = require('../services/prompt-compiler.service');
const aiEngine = require('../services/ai-engine.service');
const { TOOLS_DEFINITIONS } = require('../services/ai-engine.service');

async function testPhase4() {
  console.log('------------------------------------------------------------');
  console.log('🧪 Iniciando Testes da Fase 4: Engine de IA & Function Calling');
  console.log('------------------------------------------------------------');

  // 1. Criar dados de teste para um Tenant B2B
  const tenantRes = await query(
    `INSERT INTO tenants (nome_empresa, plano) VALUES ('Segurança Total Ltda', 'enterprise') RETURNING id, nome_empresa`
  );
  const tenant = tenantRes.rows[0];

  const aiConfigRes = await query(
    `INSERT INTO tenant_ai_configs (
      tenant_id, 
      tom_de_voz, 
      sobre_empresa, 
      servicos_oferecidos, 
      servicos_recusados, 
      regras_agendamento, 
      whatsapp_notificacao_humana,
      pausa_automatica_minutos
    ) VALUES (
      $1,
      'consultivo_especialista',
      'Empresa especializada em controle de acesso e alarmes residenciais em Contagem/MG.',
      $2,
      'Não trabalhamos com instalação de cerca elétrica e nem rastreamento veicular.',
      $3,
      '5531983525816',
      45
    ) RETURNING *`,
    [
      tenant.id,
      JSON.stringify(['Instalação de Interfones', 'Controle de Acesso Facial', 'Alarmes Monitorados']),
      JSON.stringify({ dias_semana: 'Segunda a Sexta', horario_inicio: '08:00', horario_fim: '18:00', taxas: 'Orçamento gratuito' })
    ]
  );
  const aiConfig = aiConfigRes.rows[0];

  const sessionRes = await query(
    `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name) VALUES ($1, '5531999998888@s.whatsapp.net', 'Carlos Silva') RETURNING *`,
    [tenant.id]
  );
  const session = sessionRes.rows[0];

  console.log('✅ Tenant, AI Config e Sessão de teste criados no banco.');

  // 2. Testar Prompt Compiler Dinâmico
  const compiledPrompt = promptCompiler.compileSystemPrompt(tenant, aiConfig, session);
  console.log('✅ Teste Prompt Compiler:');
  console.log('   - Contém nome da empresa ("Segurança Total Ltda"):', compiledPrompt.includes('Segurança Total Ltda'));
  console.log('   - Contém tom de voz ("CONSULTIVO_ESPECIALISTA"):', compiledPrompt.includes('CONSULTIVO_ESPECIALISTA'));
  console.log('   - Contém serviços oferecidos ("Controle de Acesso Facial"):', compiledPrompt.includes('Controle de Acesso Facial'));
  console.log('   - Contém serviços recusados ("cerca elétrica"):', compiledPrompt.includes('cerca elétrica'));
  console.log('   - Contém instrução da tool ("salvar_lead_qualificado"):', compiledPrompt.includes('salvar_lead_qualificado'));

  if (
    !compiledPrompt.includes('Segurança Total Ltda') ||
    !compiledPrompt.includes('Controle de Acesso Facial') ||
    !compiledPrompt.includes('salvar_lead_qualificado')
  ) {
    throw new Error('Falha na compilação dinâmica do System Prompt!');
  }

  // 3. Testar Validação do Schema da Tool `salvar_lead_qualificado`
  const qualTool = TOOLS_DEFINITIONS.find(t => t.function.name === 'salvar_lead_qualificado');
  if (!qualTool) throw new Error('Tool salvar_lead_qualificado não encontrada!');
  console.log('✅ Schema da Tool salvar_lead_qualificado validado:');
  console.log('   - Campos obrigatórios:', qualTool.function.parameters.required);
  console.log('   - Propriedades:', Object.keys(qualTool.function.parameters.properties));

  // 4. Testar Execução da Tool de Qualificação
  const toolArgs = {
    nome: 'Carlos Silva',
    servico: 'Controle de Acesso Facial',
    bairro_cidade: 'Eldorado / Contagem',
    urgencia: 'alta',
    detalhes: 'Prédio comercial de 3 andares com 2 portarias'
  };

  const toolResult = await aiEngine.executeQualificationTool({
    tenantId: tenant.id,
    instanceName: 'test-inst',
    sessionId: session.id,
    remoteJid: session.remote_jid,
    args: toolArgs
  });

  console.log('✅ Execução da Tool salvar_lead_qualificado:', toolResult.success);

  // 5. Verificar se `chat_sessions.dados_lead` foi atualizado no banco
  const updatedSession = await query(`SELECT dados_lead, client_name FROM chat_sessions WHERE id = $1`, [session.id]);
  const dadosSalvos = updatedSession.rows[0].dados_lead;
  console.log('✅ Validação no PostgreSQL:');
  console.log('   - Nome:', dadosSalvos.nome);
  console.log('   - Serviço:', dadosSalvos.servico);
  console.log('   - Bairro/Cidade:', dadosSalvos.bairro_cidade);
  console.log('   - Urgência:', dadosSalvos.urgencia);
  console.log('   - Qualificado em:', dadosSalvos.qualificado_em);

  if (dadosSalvos.servico !== 'Controle de Acesso Facial' || dadosSalvos.urgencia !== 'alta') {
    throw new Error('Dados do lead no banco não conferem com o payload da tool!');
  }

  // 6. Testar Limite do Histórico Recente a 10 Mensagens
  console.log('⏳ Inserindo 15 mensagens no banco para testar a janela de 10 mensagens...');
  for (let i = 1; i <= 15; i++) {
    await query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content) VALUES ($1, $2, $3, $4)`,
      [session.id, tenant.id, i % 2 === 0 ? 'assistant' : 'user', `Mensagem de histórico número ${i}`]
    );
  }

  const historyRes = await query(
    `SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [session.id]
  );
  console.log('✅ Teste Limite de Histórico:');
  console.log('   - Total de mensagens retornadas:', historyRes.rowCount, '(esperado: 10)');
  console.log('   - Mensagem mais recente na janela:', historyRes.rows[0].content, '(esperado: Mensagem 15)');
  console.log('   - Mensagem mais antiga na janela:', historyRes.rows[9].content, '(esperado: Mensagem 6)');

  if (historyRes.rowCount !== 10 || !historyRes.rows[0].content.includes('15') || !historyRes.rows[9].content.includes('6')) {
    throw new Error('Falha no limite de histórico recente a 10 mensagens!');
  }

  // 7. Limpeza dos dados de teste
  await query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
  console.log('✅ Dados de teste limpos via Cascade.');

  console.log('\n🎉 TODOS OS TESTES DA FASE 4 PASSARAM COM 100% DE SUCESSO!');
  process.exit(0);
}

testPhase4().catch(err => {
  console.error('❌ Falha nos testes da Fase 4:', err);
  process.exit(1);
});

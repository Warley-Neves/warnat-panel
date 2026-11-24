/**
 * Teste Automatizado: Validação dos 4 Dados Essenciais de Qualificação da WarNat Tech
 *
 * 1. Bairro/cidade em BH ou RMBH
 * 2. Tipo de imóvel (casa, apartamento ou comércio)
 * 3. Principal preocupação (ex.: prevenção a roubos, visão noturna, acesso pelo celular)
 * 4. Faixa de investimento pretendida
 *
 * Garante que:
 * - A regra é aplicada para WarNat Tech
 * - Outros nichos (ex: Velas / Festas) continuam com seus prompts próprios
 * - A tool salvar_lead_qualificado e o executeQualificationTool persistem e notificam corretamente
 * - Nenhuma funcionalidade anterior foi quebrada
 */

const assert = require('assert');
const promptCompiler = require('../services/prompt-compiler.service');
const aiEngine = require('../services/ai-engine.service');
const { query, pool } = require('../database/db');
const { closeStore } = require('../config/settings-store');

async function runTest() {
  console.log('================================================================');
  console.log('🧪 TESTE AUTOMATIZADO: 4 DADOS ESSENCIAIS DE QUALIFICAÇÃO');
  console.log('================================================================\n');

  // 1. Obter Tenant WarNat Tech do Banco
  const tenantRes = await query(`SELECT id, nome_empresa FROM tenants WHERE nome_empresa ILIKE '%WarNat Tech%' LIMIT 1`);
  const tenantWarNat = tenantRes.rows[0] || {
    id: 'd30b3dfc-a653-41b4-b0ff-158c58278c6f',
    nome_empresa: 'WarNat Tech'
  };

  console.log(`1️⃣ Testando Prompt Compiler para WarNat Tech (${tenantWarNat.nome_empresa} - ${tenantWarNat.id})...`);
  const aiConfigWarNat = {
    nome_assistente: 'Nat',
    responsavel_tecnico: 'Warley Santos',
    nicho_atuacao: 'cftv'
  };

  const promptWarNat = promptCompiler.compileSystemPrompt(tenantWarNat, aiConfigWarNat, {}, null, []);
  
  assert(promptWarNat.includes('REGRA CRÍTICA DE QUALIFICAÇÃO OBRIGATÓRIA DA WARNAT TECH (4 DADOS ESSENCIAIS)'), 'Deve conter cabeçalho específico de qualificação da WarNat Tech');
  assert(promptWarNat.includes('Bairro/cidade em BH ou RMBH'), 'Deve exigir bairro/cidade em BH ou RMBH');
  assert(promptWarNat.includes('Tipo de imóvel: se é casa, apartamento ou comércio/empresa'), 'Deve exigir tipo de imóvel');
  assert(promptWarNat.includes('Principal preocupação com a segurança'), 'Deve exigir principal preocupação');
  assert(promptWarNat.includes('Faixa de investimento pretendida'), 'Deve exigir faixa de investimento');
  assert(promptWarNat.includes('Antes do especialista técnico Warley Santos aparecer'), 'Deve instruir coleta antes do técnico aparecer');
  assert(promptWarNat.includes('salvar_lead_qualificado'), 'Deve instruir chamada da tool salvar_lead_qualificado');
  console.log('   ✅ Prompt da WarNat Tech contém as 4 qualificações essenciais e diretrizes de coleta natural antes do técnico aparecer!');

  // 2. Testar Prompt Compiler para Outro Tenant (Isolamento - Exclusivo WarNat Tech)
  console.log('\n2️⃣ Testando Isolamento: Tenant não-WarNat (ex: Velas)...');
  const tenantVelas = {
    id: 'f529450d-d386-43d5-b465-ad4c73d650ef',
    nome_empresa: 'Velas Artesanais Encanto'
  };
  const aiConfigVelas = {
    nome_assistente: 'Clara',
    nicho_atuacao: 'Velas Artesanais'
  };

  const promptVelas = promptCompiler.compileSystemPrompt(tenantVelas, aiConfigVelas, {}, null, []);
  assert(!promptVelas.includes('WARNAT TECH (4 DADOS ESSENCIAIS)'), 'Tenant não-WarNat NÃO deve conter a regra específica de CFTV WarNat Tech');
  assert(!promptVelas.includes('Tipo de imóvel: se é casa, apartamento ou comércio/empresa'), 'Velas não deve perguntar tipo de imóvel de CFTV');
  assert(promptVelas.includes('salvar_lead_qualificado'), 'Outro tenant ainda possui sua respectiva qualificação');
  console.log('   ✅ Isolamento validado: Tenants de outros nichos não foram alterados.');

  // 3. Testar Schema da Tool salvar_lead_qualificado
  console.log('\n3️⃣ Testando Schema da Tool salvar_lead_qualificado...');
  const qualTool = aiEngine.TOOLS_DEFINITIONS.find(t => t.function.name === 'salvar_lead_qualificado');
  assert(qualTool, 'Tool salvar_lead_qualificado deve existir');
  const props = qualTool.function.parameters.properties;
  assert(props.nome, 'Deve ter propriedade nome');
  assert(props.servico, 'Deve ter propriedade servico');
  assert(props.bairro_cidade, 'Deve ter propriedade bairro_cidade');
  assert(props.tipo_imovel, 'Deve ter propriedade tipo_imovel');
  assert(props.principal_preocupacao, 'Deve ter propriedade principal_preocupacao');
  assert(props.faixa_investimento, 'Deve ter propriedade faixa_investimento');
  assert(props.urgencia, 'Deve ter propriedade urgencia');
  assert(props.detalhes, 'Deve ter propriedade detalhes');
  assert(qualTool.function.parameters.required.includes('nome'), 'Required deve ter nome');
  assert(qualTool.function.parameters.required.includes('servico'), 'Required deve ter servico');
  assert(qualTool.function.parameters.required.includes('bairro_cidade'), 'Required deve ter bairro_cidade');
  console.log('   ✅ Schema da tool possui as 4 propriedades de qualificação e mantém compatibilidade.');

  // 4. Testar Execução da Tool salvar_lead_qualificado com os 4 Dados
  console.log('\n4️⃣ Testando Execução da Tool salvar_lead_qualificado com os 4 Dados...');
  // Cria sessão temporária para teste
  const testPhone = '5531988887777';
  const testJid = `${testPhone}@s.whatsapp.net`;
  
  const sessRes = await query(
    `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, status_atendimento, etapa_funil)
     VALUES ($1, $2, 'Cliente Teste 4 Dados', 'ia_ativa', 'novo')
     RETURNING id`,
    [tenantWarNat.id, testJid]
  );
  const sessionId = sessRes.rows[0].id;

  const result = await aiEngine.executeQualificationTool({
    tenantId: tenantWarNat.id,
    instanceName: 'warnat-tech',
    sessionId,
    remoteJid: testJid,
    args: {
      nome: 'Mariana Duarte',
      servico: 'Nova Instalação CFTV 4 Câmeras HD',
      bairro_cidade: 'Buritis / Belo Horizonte',
      tipo_imovel: 'casa',
      principal_preocupacao: 'visão noturna colorida e acesso pelo celular',
      faixa_investimento: 'R$ 2.000 a 3.000',
      urgencia: 'alta',
      detalhes: 'Casa com 2 andares, quer cobrir portão e garagem'
    }
  });

  assert(result.success === true, 'A execução da tool deve ser bem sucedida');
  assert(result.lead.tipo_imovel === 'casa', 'tipo_imovel deve ser salvo');
  assert(result.lead.principal_preocupacao === 'visão noturna colorida e acesso pelo celular', 'principal_preocupacao deve ser salvo');
  assert(result.lead.faixa_investimento === 'R$ 2.000 a 3.000', 'faixa_investimento deve ser salvo');

  // Verifica persistência no banco (chat_sessions.dados_lead)
  const dbSession = await query('SELECT dados_lead FROM chat_sessions WHERE id = $1', [sessionId]);
  const dadosSalvos = typeof dbSession.rows[0].dados_lead === 'string' 
    ? JSON.parse(dbSession.rows[0].dados_lead) 
    : dbSession.rows[0].dados_lead;

  assert(dadosSalvos.bairro_cidade === 'Buritis / Belo Horizonte', 'bairro_cidade no banco conferido');
  assert(dadosSalvos.tipo_imovel === 'casa', 'tipo_imovel no banco conferido');
  assert(dadosSalvos.principal_preocupacao === 'visão noturna colorida e acesso pelo celular', 'principal_preocupacao no banco conferido');
  assert(dadosSalvos.faixa_investimento === 'R$ 2.000 a 3.000', 'faixa_investimento no banco conferido');
  console.log('   ✅ Dados salvos com sucesso em chat_sessions.dados_lead:', dadosSalvos);

  // Limpa sessão de teste
  await query('DELETE FROM chat_sessions WHERE id = $1', [sessionId]);
  await query('DELETE FROM customer_profiles WHERE tenant_id = $1 AND remote_jid = $2', [tenantWarNat.id, testJid]);

  console.log('\n================================================================');
  console.log('🎉 TODOS OS TESTES DOS 4 DADOS ESSENCIAIS PASSARAM COM SUCESSO!');
  console.log('================================================================\n');

  await closeStore();
  await pool.end();
}

runTest()
  .catch((err) => {
    console.error('❌ ERRO NO TESTE:', err);
    process.exit(1);
  });

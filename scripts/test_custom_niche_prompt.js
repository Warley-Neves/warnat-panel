/**
 * Teste de Validação de Nicho Personalizado vs CFTV
 * Garante que cada Tenant recebe um System Prompt adaptado ao seu nicho de atuação e funil.
 */

const promptCompiler = require('../services/prompt-compiler.service');

function runTest() {
  console.log('====================================================================');
  console.log('🕯️  INICIANDO TESTES DE COMPILAÇÃO DE PROMPT PARA NICHOS PERSONALIZADOS');
  console.log('====================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition, desc) {
    total++;
    if (condition) {
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${desc}`);
      throw new Error(`Falha no teste: ${desc}`);
    }
  }

  // -------------------------------------------------------------------------
  // CENÁRIO 1: Tenant de Velas Artesanais (wn-velas-artesanais)
  // -------------------------------------------------------------------------
  console.log('--- CENÁRIO 1: Tenant WN Velas Artesanais (Nicho: Velas & Aromatizadores) ---');
  
  const velasTenant = {
    id: 'tenant-velas-123',
    nome_empresa: 'WN Velas Artesanais'
  };

  const velasConfig = {
    nome_assistente: 'Nat',
    nicho_atuacao: 'Velas Artesanais Aromáticas & Home Spray',
    tipo_negocio: 'produtos',
    objetivo_funil: 'venda_produtos',
    responsavel_tecnico: 'Natália & Warley',
    regiao_atendimento: 'Belo Horizonte e envio para todo o Brasil via Correios/Sedex',
    tom_de_voz: 'amigavel_e_caloroso',
    sobre_empresa: 'Ateliê artesanal de velas ecológicas de cera de coco e aromatizadores de ambiente feitos à mão com essências premium.',
    pergunta_inicial_qualificacao: 'Gostaria de conhecer nossos aromas e kits de velas para pronta-entrega ou está procurando lembrancinhas personalizadas para um evento?',
    diretrizes_funil: '1. Descobrir se é presente ou uso próprio;\n2. Apresentar os aromas mais pedidos (Baunilha Negra, Lavanda Francesa, Flor de Cerejeira);\n3. Perguntar quantidade desejada;\n4. Coletar CEP para frete;\n5. Confirmar pedido e enviar Pix.',
    politicas_comerciais: 'Aceitamos Pix com 5% de desconto e Cartão de Crédito. Enviamos em até 2 dias úteis. Frete grátis para compras acima de R$ 180,00.',
    servicos_oferecidos: [
      { nome: 'Vela Aromática Pote Vidro 140g - Baunilha Negra', faixa_preco: 'R$ 45,00' },
      { nome: 'Vela Aromática Lata 90g - Lavanda Francesa', faixa_preco: 'R$ 35,00' },
      { nome: 'Home Spray Aromatizador 200ml - Flor de Cerejeira', faixa_preco: 'R$ 55,00' },
      { nome: 'Kit Trio de Mini Velas para Presente', faixa_preco: 'R$ 89,90' }
    ],
    servicos_recusados: 'Velas industriais de parafina comum, atacado acima de 300 unidades sem 15 dias de antecedência',
    taxa_manutencao_reais: null
  };

  const velasPrompt = promptCompiler.compileSystemPrompt(velasTenant, velasConfig);

  // Asserções para Velas Artesanais
  assert(velasPrompt.includes('WN Velas Artesanais'), 'Contém o nome da empresa WN Velas Artesanais');
  assert(velasPrompt.includes('Natália & Warley'), 'Contém o nome dos responsáveis');
  assert(velasPrompt.includes('Velas Artesanais Aromáticas & Home Spray'), 'Contém o nicho de velas artesanais');
  assert(velasPrompt.includes('Baunilha Negra') && velasPrompt.includes('Lavanda Francesa'), 'Contém o catálogo de produtos e aromas');
  assert(velasPrompt.includes('Pix com 5% de desconto'), 'Contém as políticas de pagamento e frete');
  assert(velasPrompt.includes('lembrancinhas personalizadas'), 'Contém a pergunta inicial de sondagem personalizada');

  // Asserções CRÍTICAS: NÃO deve conter CFTV ou câmeras
  assert(!velasPrompt.includes('CFTV'), 'CRÍTICO: NÃO menciona CFTV para velas artesanais');
  assert(!velasPrompt.includes('DVR'), 'CRÍTICO: NÃO menciona DVR para velas artesanais');
  assert(!velasPrompt.includes('pontos cegos'), 'CRÍTICO: NÃO menciona pontos cegos para velas artesanais');
  assert(!velasPrompt.includes('câmeras de segurança'), 'CRÍTICO: NÃO menciona câmeras de segurança para velas artesanais');
  assert(!velasPrompt.includes('140,00'), 'CRÍTICO: NÃO menciona taxa de manutenção de R$ 140,00 para velas');

  console.log('\n--- CENÁRIO 2: Tenant CFTV / Segurança (WarNat Tech) ---');
  
  const cftvTenant = {
    id: 'tenant-cftv-123',
    nome_empresa: 'WarNat Tech'
  };

  const cftvConfig = {
    nome_assistente: 'Nat',
    nicho_atuacao: 'Segurança Eletrônica & CFTV',
    tipo_negocio: 'servicos',
    objetivo_funil: 'agendamento',
    responsavel_tecnico: 'Warley Santos',
    regiao_atendimento: 'Belo Horizonte, Barreiro e Grande BH',
    tom_de_voz: 'profissional_humanizado',
    taxa_manutencao_reais: 140.0
  };

  const cftvPrompt = promptCompiler.compileSystemPrompt(cftvTenant, cftvConfig);

  assert(cftvPrompt.includes('WarNat Tech'), 'Contém WarNat Tech');
  assert(cftvPrompt.includes('Warley Santos'), 'Contém responsável Warley Santos');
  assert(cftvPrompt.includes('140,00'), 'Contém a taxa de manutenção de R$ 140,00');
  assert(cftvPrompt.includes('pontos cegos'), 'Contém avaliação de pontos cegos');
  assert(cftvPrompt.includes('CFTV'), 'Contém especialidade em CFTV');

  console.log('\n====================================================================');
  console.log(`🎉 TODOS OS ${total} TESTES DE NICHO PASSARAM COM SUCESSO! (${passed}/${total})`);
  console.log('====================================================================\n');
}

runTest();

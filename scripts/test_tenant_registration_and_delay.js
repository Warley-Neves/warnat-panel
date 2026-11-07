const http = require('http');
const { query } = require('../database/db');
const authService = require('../database/auth.service');
const { handleV2Routes } = require('../panel/routes/v2.routes');

function request(port, path, method, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTest() {
  console.log('====================================================================');
  console.log('🏢 TESTE: CONFIGURAÇÃO DE NOVOS CLIENTES E TEMPO DE RESPOSTA');
  console.log('====================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(cond, name) {
    total++;
    if (cond) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}`);
      throw new Error(`Falha no teste: ${name}`);
    }
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try { body = JSON.parse(raw); } catch (e) {}
    }
    const handled = await handleV2Routes(req, res, urlObj.pathname, req.method, body);
    if (!res.writableEnded && !handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise(r => server.listen(3498, '127.0.0.1', r));
  console.log('📡 Servidor de testes escutando na porta 3498.\n');

  try {
    // 1. Cadastra um novo cliente/tenant genérico
    const timestamp = Date.now();
    const testEmail = `dr_marcelo_${timestamp}@odontoviva.com`;
    const regRes = await authService.registerTenantAndAdmin({
      nome_empresa: 'Clínica Odonto Viva',
      nome: 'Dr. Marcelo Ribeiro',
      email: testEmail,
      password: 'SenhaSegura123!',
      sobre_empresa: 'Clínica especializada em implantes e estética dental.'
    });

    const tenantId = regRes.tenant.id;
    const token = regRes.token;

    assert(!!token, 'Novo cliente (Tenant) registrado com sucesso');

    // 2. Consulta configurações iniciais que o cliente verá no painel
    const getRes = await request(3498, '/api/v2/tenant/ai-config', 'GET', null, token);
    assert(getRes.status === 200 && getRes.data.success, 'GET /api/v2/tenant/ai-config retorna status 200');
    
    const config = getRes.data.config;
    assert(config !== null, 'Configuração da IA criada automaticamente para o novo tenant');
    assert(config.nome_assistente === 'Nat', 'Nome da assistente padrão é "Nat"');
    assert(config.responsavel_tecnico === 'Dr. Marcelo Ribeiro', 'Responsável técnico inicializado com o nome do próprio cliente');
    assert(config.tempo_resposta_segundos === 3, 'Tempo de resposta da automação inicializado com 3 segundos');
    assert(config.tipo_negocio === 'servicos', 'Tipo de negócio padrão atribuído');
    assert(config.regras_agendamento && config.regras_agendamento.dias.length > 0, 'Dias de atendimento comercial inicializados');

    // 3. Cliente personaliza TUDO pelo painel (PUT /api/v2/tenant/ai-config)
    const updatePayload = {
      modo_atendimento: 'automacao',
      nicho_atuacao: 'Odontologia e Harmonização Orofacial',
      tipo_negocio: 'agendamento',
      objetivo_funil: 'agendamento',
      pergunta_inicial_qualificacao: 'Você procura por avaliação para implantes, ortodontia com alinhadores invisíveis ou clareamento a laser?',
      diretrizes_funil: '1. Perguntar a principal queixa estética ou funcional;\n2. Explicar brevemente o método de diagnóstico 3D;\n3. Sugerir horários livres da agenda;\n4. Confirmar dados e enviar lembrete.',
      politicas_comerciais: 'Aceitamos convênios selecionados, Pix e parcelamento em até 12x no cartão. Avaliação inicial inclui escaneamento digital.',
      nome_assistente: 'Nat',
      responsavel_tecnico: 'Dr. Marcelo Ribeiro',
      regiao_atendimento: 'Belo Horizonte e Região Metropolitana',
      taxa_manutencao_reais: null,
      tom_de_voz: 'amigavel_e_caloroso',
      pausa_automatica_minutos: 30,
      tempo_resposta_segundos: 8, // Configurado para 8 segundos de resposta humana
      whatsapp_notificacao_humana: '5531999998888',
      sobre_empresa: 'Clínica Odonto Viva: referência em estética e saúde bucal com mais de 10 anos de excelência.',
      instrucoes_personalizadas: 'Sempre mencione que temos estacionamento gratuito no subsolo do edifício.',
      servicos_oferecidos: [
        { nome: 'Implante Dentário com Carga Imediata', faixa_preco: 'Consulte avaliação' },
        { nome: 'Alinhadores Invisíveis', faixa_preco: 'Planos a partir de R$ 250/mês' },
        { nome: 'Clareamento Dental a Laser', faixa_preco: 'R$ 650,00' }
      ],
      servicos_recusados: 'Não realizamos atendimento de emergência hospitalar de madrugada.',
      regras_agendamento: {
        horario_inicio: '08:00',
        horario_fim: '19:00',
        dias_atendimento: ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'],
        slots_agendamento: ['09:00', '11:00', '14:00', '16:00', '18:00'],
        politica_agendamento: 'Consulta de avaliação com escaneamento intraoral.'
      }
    };

    const putRes = await request(3498, '/api/v2/tenant/ai-config', 'PUT', updatePayload, token);
    assert(putRes.status === 200 && putRes.data.success, 'Configurações completas salvas com sucesso via PUT');

    // 4. Re-consulta pelo painel para validar persistência de todos os novos campos
    const verifyRes = await request(3498, '/api/v2/tenant/ai-config', 'GET', null, token);
    const vConfig = verifyRes.data.config;

    assert(vConfig.nicho_atuacao === 'Odontologia e Harmonização Orofacial', 'Nicho atualizado com sucesso');
    assert(vConfig.tipo_negocio === 'agendamento', 'Tipo de negócio salvo como agendamento');
    assert(vConfig.objetivo_funil === 'agendamento', 'Objetivo do funil salvo');
    assert(vConfig.tempo_resposta_segundos === 8, 'Tempo de resposta da automação atualizado para 8 segundos');
    assert(vConfig.instrucoes_personalizadas.includes('estacionamento gratuito'), 'Instruções personalizadas salvas e persistidas');
    assert(vConfig.pergunta_inicial_qualificacao.includes('alinhadores invisíveis'), 'Pergunta inicial de qualificação persistida');
    assert(vConfig.politicas_comerciais.includes('12x no cartão'), 'Políticas comerciais persistidas');
    assert(Array.isArray(vConfig.servicos_oferecidos) && vConfig.servicos_oferecidos.length === 3, 'Catálogo de serviços/produtos persistido');

    // Limpeza dos dados de teste
    await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    console.log('\n🧹 Dados de teste limpos via Cascade.');

    console.log('\n====================================================================');
    console.log(`🎉 TODOS OS ${total} TESTES DE CLIENTES E TEMPO DE RESPOSTA PASSARAM COM SUCESSO! (${passed}/${total})`);
    console.log('====================================================================\n');
  } catch (err) {
    console.error('❌ Erro no teste:', err);
    process.exit(1);
  } finally {
    server.close();
    process.exit(0);
  }
}

runTest();

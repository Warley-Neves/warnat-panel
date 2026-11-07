/**
 * Teste de Verificação Completa do Avanço de Datas e Proteção Anti-Ocupação
 * Verifica se a IA avança para a próxima data quando o cliente pede outro dia/outro sábado,
 * e se NUNCA sugere ou marca horários ocupados.
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const aiEngine = require('../services/ai-engine.service');
const { query, pool } = require('../database/db');

async function run() {
  console.log('=== TESTE DE AVANÇO DE DATAS E PROTEÇÃO CONTRA HORÁRIOS OCUPADOS ===\n');

  // Busca um tenant existente para testes
  const tenantRes = await query(`SELECT id, nome_empresa FROM tenants LIMIT 1`);
  if (tenantRes.rowCount === 0) {
    console.error('Nenhum tenant encontrado no banco de dados!');
    process.exit(1);
  }
  const testTenant = tenantRes.rows[0];
  console.log(`Tenant de teste: ${testTenant.nome_empresa} (${testTenant.id})`);

  // Garante que o tenant tenha regras configuradas para sábados
  await query(
    `UPDATE tenant_ai_configs 
     SET regras_agendamento = $2 
     WHERE tenant_id = $1`,
    [
      testTenant.id,
      JSON.stringify({
        dias_atendimento: ['sabado'],
        slots_agendamento: ['08:00', '10:00', '12:00', '14:00', '16:00']
      })
    ]
  );

  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`[PASS] Teste ${total}: ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] Teste ${total}: ${message}`);
    }
  }

  try {
    // --------------------------------------------------------------------------
    // Teste 1: Primeira consulta - qualificação e sugestão da primeira data disponível
    // --------------------------------------------------------------------------
    const turn1History = [
      { role: 'user', content: 'Olá, gostaria de saber sobre instalação de câmeras novas na minha casa.' }
    ];

    const turn1Slots = await aiEngine.executeGetSlotsTool({
      tenantId: testTenant.id,
      historyMessages: turn1History,
      args: {}
    });

    assert(turn1Slots.success === true, 'Turno 1: get_available_calendar_slots retorna sucesso');
    assert(turn1Slots.slots.length === 2, 'Turno 1: Retorna exatamente 2 horários');
    const firstSuggestedDate = turn1Slots.slots[0].date;
    const firstSuggestedDay = turn1Slots.slots[0].dayOfWeek;
    console.log(`   -> Primeira data sugerida: ${firstSuggestedDay} (${firstSuggestedDate}) às ${turn1Slots.slots[0].time} e ${turn1Slots.slots[1].time}`);
    assert(firstSuggestedDay === 'Sábado', 'Turno 1: Dia sugerido é Sábado conforme regras do tenant');

    // --------------------------------------------------------------------------
    // Teste 2: Cliente pede outro sábado / diz que não pode na data sugerida
    // --------------------------------------------------------------------------
    const turn2History = [
      ...turn1History,
      {
        role: 'assistant',
        content: `Perfeito! Para nova instalação nossa visita é gratuita. No momento temos disponibilidade para *${firstSuggestedDay} (${turn1Slots.slots[0].description.split(' às ')[0]})* às *08:00* ou às *10:00*.`
      },
      {
        role: 'user',
        content: `Não posso no sábado dia ${turn1Slots.slots[0].date}, tem outro sábado mais pra frente?`
      }
    ];

    const turn2Slots = await aiEngine.executeGetSlotsTool({
      tenantId: testTenant.id,
      historyMessages: turn2History,
      args: {}
    });

    assert(turn2Slots.success === true, 'Turno 2: get_available_calendar_slots retorna sucesso');
    assert(turn2Slots.slots.length === 2, 'Turno 2: Retorna 2 horários');
    const secondSuggestedDate = turn2Slots.slots[0].date;
    const secondSuggestedDay = turn2Slots.slots[0].dayOfWeek;
    console.log(`   -> Segunda data sugerida: ${secondSuggestedDay} (${secondSuggestedDate}) às ${turn2Slots.slots[0].time} e ${turn2Slots.slots[1].time}`);

    assert(secondSuggestedDate !== firstSuggestedDate, `Turno 2: A nova data (${secondSuggestedDate}) é DIFERENTE da data recusada (${firstSuggestedDate})`);
    assert(new Date(secondSuggestedDate) > new Date(firstSuggestedDate), `Turno 2: A nova data (${secondSuggestedDate}) avançou para frente da recusada (${firstSuggestedDate})`);
    assert(secondSuggestedDay === 'Sábado', 'Turno 2: Nova data continua sendo um Sábado');

    // --------------------------------------------------------------------------
    // Teste 3: Cliente recusa novamente e pede outro dia
    // --------------------------------------------------------------------------
    const turn3History = [
      ...turn2History,
      {
        role: 'assistant',
        content: `Tranquilo! Para o próximo sábado (${secondSuggestedDate}) temos disponibilidade às 08:00 ou às 10:00.`
      },
      {
        role: 'user',
        content: `Puts, nessa data também não posso, tem outro sábado?`
      }
    ];

    const turn3Slots = await aiEngine.executeGetSlotsTool({
      tenantId: testTenant.id,
      historyMessages: turn3History,
      args: {}
    });

    assert(turn3Slots.success === true, 'Turno 3: get_available_calendar_slots retorna sucesso');
    const thirdSuggestedDate = turn3Slots.slots[0].date;
    console.log(`   -> Terceira data sugerida: ${turn3Slots.slots[0].dayOfWeek} (${thirdSuggestedDate})`);
    assert(thirdSuggestedDate !== firstSuggestedDate && thirdSuggestedDate !== secondSuggestedDate, 'Turno 3: Nova data não repete nenhuma das duas anteriores');
    assert(new Date(thirdSuggestedDate) > new Date(secondSuggestedDate), 'Turno 3: Data avançou ainda mais para o próximo sábado');

    // --------------------------------------------------------------------------
    // Teste 4: Proteção Anti-Ocupação (Horário já reservado na data sugerida)
    // --------------------------------------------------------------------------
    // Vamos simular que o horário das 08:00 da terceira data está reservado por outro cliente
    const testSlotDate = new Date(`${thirdSuggestedDate}T08:00:00-03:00`);
    const dummyRemoteJid = '5511999990001@s.whatsapp.net';

    // Limpa eventuais agendamentos de teste anteriores
    await query(
      `DELETE FROM appointments WHERE tenant_id = $1 AND remote_jid = $2`,
      [testTenant.id, dummyRemoteJid]
    );

    // Insere agendamento ativo às 08:00
    await query(
      `INSERT INTO appointments (tenant_id, remote_jid, servico, data_agendada, status, tipo_agendamento)
       VALUES ($1, $2, 'Nova Instalação', $3, 'agendado', 'VISITA_TECNICA')`,
      [testTenant.id, dummyRemoteJid, testSlotDate]
    );

    // Agora consulta slots a partir do thirdSuggestedDate
    const occupiedCheckSlots = await aiEngine.executeGetSlotsTool({
      tenantId: testTenant.id,
      historyMessages: turn3History,
      args: { fromDate: thirdSuggestedDate }
    });

    console.log(`   -> Horários retornados para ${thirdSuggestedDate} após ocupar 08:00:`, occupiedCheckSlots.slots.map(s => `${s.date} ${s.time}`));
    const hasOccupiedSlot = occupiedCheckSlots.slots.some(s => s.date === thirdSuggestedDate && s.time === '08:00');
    assert(!hasOccupiedSlot, 'Teste 4: O horário ocupado das 08:00 NÃO foi sugerido');
    assert(occupiedCheckSlots.slots[0].time === '10:00', 'Teste 4: Primeiro horário livre oferecido foi 10:00');

    // --------------------------------------------------------------------------
    // Teste 5: Tentativa de agendar o horário ocupado é barrada
    // --------------------------------------------------------------------------
    const attemptBookBusy = await aiEngine.executeBookAppointmentTool({
      tenantId: testTenant.id,
      sessionId: 'dummy-session-123',
      remoteJid: '5511988887777@s.whatsapp.net',
      pushName: 'Outro Cliente',
      historyMessages: turn3History,
      args: {
        date: thirdSuggestedDate,
        time: '08:00',
        appointmentType: 'VISITA_TECNICA'
      }
    });

    assert(attemptBookBusy.success === false, 'Teste 5: book_appointment recusa agendamento em horário ocupado');
    assert(attemptBookBusy.error === 'horario_ocupado', 'Teste 5: Erro retornado é horario_ocupado');
    assert(attemptBookBusy.suggestedSlots.length > 0, 'Teste 5: Retorna alternativas de horários livres');

    // --------------------------------------------------------------------------
    // Teste 6: Dia completamente lotado avança para o próximo dia
    // --------------------------------------------------------------------------
    // Ocupa todos os slots restantes de thirdSuggestedDate (10:00, 12:00, 14:00, 16:00)
    for (const t of ['10:00', '12:00', '14:00', '16:00']) {
      await query(
        `INSERT INTO appointments (tenant_id, remote_jid, servico, data_agendada, status, tipo_agendamento)
         VALUES ($1, $2, 'Nova Instalação', $3, 'agendado', 'VISITA_TECNICA')`,
        [testTenant.id, dummyRemoteJid, new Date(`${thirdSuggestedDate}T${t}:00-03:00`)]
      );
    }

    // Consulta slots a partir de thirdSuggestedDate: como está tudo ocupado, deve pular para o próximo sábado!
    const fullDaySlots = await aiEngine.executeGetSlotsTool({
      tenantId: testTenant.id,
      historyMessages: [{ role: 'user', content: 'nova instalação' }],
      args: { fromDate: thirdSuggestedDate }
    });

    assert(fullDaySlots.success === true, 'Teste 6: get_available_calendar_slots retorna sucesso em dia lotado');
    const jumpedDate = fullDaySlots.slots[0].date;
    console.log(`   -> Data retornada após lotar ${thirdSuggestedDate}: ${jumpedDate}`);
    assert(jumpedDate !== thirdSuggestedDate, `Teste 6: Pulou o dia totalmente ocupado (${thirdSuggestedDate}) para uma nova data (${jumpedDate})`);
    assert(new Date(jumpedDate) > new Date(thirdSuggestedDate), 'Teste 6: A nova data é posterior ao dia lotado');

    // Limpeza dos agendamentos de teste
    await query(
      `DELETE FROM appointments WHERE tenant_id = $1 AND remote_jid = $2`,
      [testTenant.id, dummyRemoteJid]
    );

    console.log(`\n==================================================`);
    console.log(`RESULTADO FINAL: ${passed}/${total} testes passaram.`);
    console.log(`==================================================\n`);

    if (passed === total) {
      process.exit(0);
    } else {
      process.exit(1);
    }

  } catch (err) {
    console.error('Erro na execução dos testes:', err);
    process.exit(1);
  } finally {
    if (pool && pool.end) {
      await pool.end();
    }
  }
}

run();

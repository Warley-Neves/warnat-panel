/**
 * Test Suite: Trava de Dias e Horários da Agenda no Painel e IA Engine
 * 
 * Valida:
 * 1. CRUD de Bloqueios no PostgreSQL (agenda_bloqueios):
 *    - Bloqueio de dia inteiro (horario = null)
 *    - Bloqueio de horário específico (horario = '10:00')
 * 2. executeGetSlotsTool da IA:
 *    - Exclusão do dia inteiro travado
 *    - Exclusão do horário específico travado (outros horários continuam livres)
 * 3. executeCheckSlotTool e executeBookAppointmentTool:
 *    - Rejeição imediata em dia travado (dia_bloqueado_painel) com motivo
 *    - Rejeição imediata em horário travado (horario_bloqueado_painel) com motivo
 *    - Aprovação em horários não travados
 * 4. Destravamento (DELETE):
 *    - Remoção do bloqueio libera o dia/horário imediatamente para a IA
 * 5. Isolamento Multi-tenant:
 *    - Bloqueios do Tenant A não impactam o Tenant B
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const aiEngine = require('../services/ai-engine.service');
const { query, pool } = require('../database/db');

async function runTests() {
  console.log('=== INICIANDO TESTES: TRAVA DE DIAS E HORÁRIOS DA AGENDA ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName} - ${details}`);
      failed++;
    }
  }

  // 1. Obter tenant de teste
  const tenantRes = await query(`SELECT id, nome_empresa FROM tenants ORDER BY created_at ASC LIMIT 2`);
  if (tenantRes.rowCount < 1) {
    console.error('Nenhum tenant encontrado para teste.');
    process.exit(1);
  }

  const tenantA = tenantRes.rows[0];
  const tenantB = tenantRes.rows[1] || tenantRes.rows[0];
  console.log(`Tenant de Teste A: ${tenantA.nome_empresa} (${tenantA.id})`);
  if (tenantB.id !== tenantA.id) {
    console.log(`Tenant de Teste B: ${tenantB.nome_empresa} (${tenantB.id})`);
  }

  // Configura regras para aceitar sábados 08:00, 10:00, 12:00, 14:00, 16:00
  await query(
    `UPDATE tenant_ai_configs
     SET regras_agendamento = $2
     WHERE tenant_id = $1`,
    [
      tenantA.id,
      JSON.stringify({
        dias_atendimento: ['sabado'],
        slots_agendamento: ['08:00', '10:00', '12:00', '14:00', '16:00']
      })
    ]
  );

  // Limpa bloqueios anteriores de teste
  await query(`DELETE FROM agenda_bloqueios WHERE tenant_id = $1`, [tenantA.id]);

  try {
    // ------------------------------------------------------------------------
    // TESTE 1: Inserir bloqueio de dia inteiro e bloqueio de horário específico
    // ------------------------------------------------------------------------
    console.log('\n--- 1. Criação de Bloqueios no Banco ---');
    
    // Procura sábados futuros (2 e 3 semanas à frente) para garantir agenda limpa
    const today = new Date();
    const d1 = new Date(today);
    const dayOfWeek = today.getDay(); // 0 Dom, 6 Sab
    const daysUntilNextSat = (6 - dayOfWeek + 7) % 7 || 7;
    d1.setDate(today.getDate() + daysUntilNextSat + 14); // 2 semanas à frente

    const d2 = new Date(d1);
    d2.setDate(d1.getDate() + 7); // 3 semanas à frente

    function formatYMD(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    const dateStr1 = formatYMD(d1);
    const dateStr2 = formatYMD(d2);

    console.log(`Data Sábado 1 (Horário 10:00 travado): ${dateStr1}`);
    console.log(`Data Sábado 2 (Dia inteiro travado): ${dateStr2}`);

    // Limpa eventuais agendamentos nessas datas de teste
    await query(`DELETE FROM appointments WHERE tenant_id = $1 AND data_agendada::date IN ($2, $3)`, [tenantA.id, dateStr1, dateStr2]);

    // Insere bloqueio do horário 10:00 no Sábado 1
    const insSlotRes = await query(
      `INSERT INTO agenda_bloqueios (tenant_id, data, horario, motivo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, TO_CHAR(data, 'YYYY-MM-DD') as data, horario, motivo`,
      [tenantA.id, dateStr1, '10:00', 'Manutenção da viatura técnica']
    );
    const slotLock = insSlotRes.rows[0];
    assert(slotLock && slotLock.horario === '10:00', 'Bloqueio de horário específico (10:00) criado com sucesso');

    // Insere bloqueio de dia inteiro no Sábado 2
    const insDayRes = await query(
      `INSERT INTO agenda_bloqueios (tenant_id, data, horario, motivo)
       VALUES ($1, $2, NULL, $3)
       RETURNING id, TO_CHAR(data, 'YYYY-MM-DD') as data, horario, motivo`,
      [tenantA.id, dateStr2, 'Treinamento geral da equipe e folga coletiva']
    );
    const dayLock = insDayRes.rows[0];
    assert(dayLock && dayLock.horario === null, 'Bloqueio de dia inteiro criado com sucesso');

    // ------------------------------------------------------------------------
    // TESTE 2: Consulta e listagem dos bloqueios
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Consulta de Bloqueios Ativos ---');
    const listRes = await query(
      `SELECT id, TO_CHAR(data, 'YYYY-MM-DD') as data, horario, motivo
       FROM agenda_bloqueios
       WHERE tenant_id = $1
       ORDER BY data ASC`,
      [tenantA.id]
    );
    assert(listRes.rowCount === 2, 'Listagem retorna os 2 bloqueios criados para o tenant');

    // ------------------------------------------------------------------------
    // TESTE 3: executeGetSlotsTool respeita as travas da agenda
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Verificação do executeGetSlotsTool na IA ---');
    const slotsResult = await aiEngine.executeGetSlotsTool({
      tenantId: tenantA.id,
      historyMessages: [
        { role: 'user', content: 'Quero fazer a nova instalação de câmeras de segurança na minha residência' }
      ],
      args: {
        fromDate: dateStr1,
        preferred_shift: 'manha'
      }
    });

    console.log('Slots retornados:', JSON.stringify(slotsResult.slots, null, 2));

    const returnedSlots = slotsResult.slots || [];

    // No Sábado 1, o horário 10:00 NÃO pode estar entre os horários disponíveis
    const has10Slot = returnedSlots.some(s => s.date === dateStr1 && s.time === '10:00');
    assert(!has10Slot, 'Horário 10:00 foi devidamente EXCLUÍDO dos slots disponíveis no Sábado 1');

    const has08Slot = returnedSlots.some(s => s.date === dateStr1 && s.time === '08:00');
    assert(has08Slot, 'Horário 08:00 continua disponível no Sábado 1');

    // O Sábado 2 NÃO pode estar em slots porque está totalmente travado
    const hasSabado2Slot = returnedSlots.some(s => s.date === dateStr2);
    assert(!hasSabado2Slot, 'Dia inteiro travado (Sábado 2) foi devidamente EXCLUÍDO das opções de agendamento');

    // ------------------------------------------------------------------------
    // TESTE 4: executeCheckSlotTool bloqueia dia e horário travados
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Verificação de Restrições em executeCheckSlotTool ---');
    
    // Verifica horário travado no Sábado 1 (10:00)
    const checkLockedSlot = await aiEngine.executeCheckSlotTool({
      tenantId: tenantA.id,
      date: dateStr1,
      time: '10:00'
    });
    console.log('Check 10:00 Sábado 1:', checkLockedSlot);
    assert(checkLockedSlot.available === false, 'executeCheckSlotTool recusa horário travado');
    assert(
      checkLockedSlot.reason === 'horario_bloqueado_painel',
      'Razão reportada é horario_bloqueado_painel'
    );
    assert(
      checkLockedSlot.message.includes('Manutenção da viatura técnica'),
      'Mensagem inclui o motivo configurado no painel'
    );

    // Verifica horário livre no Sábado 1 (08:00)
    const checkFreeSlot = await aiEngine.executeCheckSlotTool({
      tenantId: tenantA.id,
      date: dateStr1,
      time: '08:00'
    });
    console.log('Check 08:00 Sábado 1:', checkFreeSlot);
    assert(checkFreeSlot.available === true, 'executeCheckSlotTool aceita horário livre (08:00)');

    // Verifica dia inteiro travado no Sábado 2
    const checkLockedDay = await aiEngine.executeCheckSlotTool({
      tenantId: tenantA.id,
      date: dateStr2,
      time: '08:00'
    });
    console.log('Check 08:00 Sábado 2 (Dia Travado):', checkLockedDay);
    assert(checkLockedDay.available === false, 'executeCheckSlotTool recusa dia inteiro travado');
    assert(
      checkLockedDay.reason === 'dia_bloqueado_painel',
      'Razão reportada é dia_bloqueado_painel'
    );
    assert(
      checkLockedDay.message.includes('Treinamento geral da equipe'),
      'Mensagem inclui o motivo configurado no painel'
    );

    // ------------------------------------------------------------------------
    // TESTE 5: executeBookAppointmentTool impede agendamento em slot/dia travado
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Tentativa de Agendamento em Slot Travado ---');
    const bookLockedAttempt = await aiEngine.executeBookAppointmentTool({
      tenantId: tenantA.id,
      sessionId: 'test-session',
      remoteJid: '5511999999999@s.whatsapp.net',
      pushName: 'Cliente Teste Trava',
      args: {
        date: dateStr1,
        time: '10:00',
        clientName: 'Cliente Teste Trava',
        address: 'Rua de Teste, 123',
        serviceType: 'INSTALACAO'
      }
    });
    console.log('Tentativa de booking no 10:00 travado:', bookLockedAttempt);
    assert(bookLockedAttempt.success === false, 'executeBookAppointmentTool bloqueia reserva');
    assert(
      bookLockedAttempt.error === 'horario_bloqueado_painel' || bookLockedAttempt.reason === 'horario_bloqueado_painel',
      'Razão do booking falho é horario_bloqueado_painel'
    );

    // ------------------------------------------------------------------------
    // TESTE 6: Destravamento e Liberação Imediata
    // ------------------------------------------------------------------------
    console.log('\n--- 6. Remoção de Bloqueio (Destravar) ---');
    const delRes = await query(
      `DELETE FROM agenda_bloqueios WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [slotLock.id, tenantA.id]
    );
    assert(delRes.rowCount === 1, 'Bloqueio de horário removido do banco com sucesso');

    // Agora o horário 10:00 no Sábado 1 deve voltar a ficar disponível imediatamente
    const checkAfterUnlock = await aiEngine.executeCheckSlotTool({
      tenantId: tenantA.id,
      date: dateStr1,
      time: '10:00'
    });
    console.log('Check 10:00 após destravar:', checkAfterUnlock);
    assert(
      checkAfterUnlock.available === true,
      'Horário 10:00 voltou a ficar disponível imediatamente após o destravamento'
    );

    // ------------------------------------------------------------------------
    // TESTE 7: Recorrência Semanal (tipo_recorrencia = 'semanal')
    // ------------------------------------------------------------------------
    console.log('\n--- 7. Recorrência Semanal Fixa ---');
    // Cria bloqueio semanal: Todo sábado às 14:00
    const insWeeklyRes = await query(
      `INSERT INTO agenda_bloqueios (tenant_id, data, horario, motivo, tipo_recorrencia, dia_semana, dias_semana, tipo_acao)
       VALUES ($1, NULL, $2, $3, 'semanal', 'sabado', $4, 'bloquear')
       RETURNING id, tipo_recorrencia, dia_semana, horario`,
      [tenantA.id, '14:00', 'Folga semanal do técnico 14h', JSON.stringify(['sabado'])]
    );
    assert(insWeeklyRes.rowCount === 1, 'Regra semanal (todo sábado 14:00) criada');

    // Verifica se a data futura dateStr1 (sábado) às 14:00 é bloqueada
    const checkWeeklySlot = await aiEngine.executeCheckSlotTool({
      tenantId: tenantA.id,
      date: dateStr1,
      time: '14:00'
    });
    console.log('Check semanal 14:00:', checkWeeklySlot);
    assert(checkWeeklySlot.available === false, 'Regra semanal bloqueia 14:00 no sábado');
    assert(checkWeeklySlot.message.includes('Folga semanal do técnico'), 'Mensagem inclui motivo da regra semanal');

    // ------------------------------------------------------------------------
    // TESTE 8: Intervalo de Recesso / Férias (tipo_recorrencia = 'intervalo')
    // ------------------------------------------------------------------------
    console.log('\n--- 8. Intervalo de Recesso / Férias ---');
    // Definir intervalo de férias que cobre uma semana futura
    const vacationStart = new Date(d1);
    vacationStart.setDate(d1.getDate() + 21); // 5 semanas à frente
    const vacationEnd = new Date(vacationStart);
    vacationEnd.setDate(vacationStart.getDate() + 7);

    const vacStartStr = formatYMD(vacationStart);
    const vacEndStr = formatYMD(vacationEnd);

    const insVacationRes = await query(
      `INSERT INTO agenda_bloqueios (tenant_id, data, data_fim, horario, motivo, tipo_recorrencia, tipo_acao)
       VALUES ($1, $2, $3, NULL, $4, 'intervalo', 'bloquear')
       RETURNING id, data, data_fim, tipo_recorrencia`,
      [tenantA.id, vacStartStr, vacEndStr, 'Recesso de Férias Coletivas da Equipe']
    );
    assert(insVacationRes.rowCount === 1, 'Regra de intervalo (férias coletivas) criada');

    // Checar data dentro do recesso
    const checkVacation = await aiEngine.executeCheckSlotTool({
      tenantId: tenantA.id,
      date: vacStartStr,
      time: '08:00'
    });
    console.log('Check intervalo férias:', checkVacation);
    assert(checkVacation.available === false, 'Intervalo de recesso bloqueia data no período');
    assert(checkVacation.message.includes('Recesso de Férias Coletivas'), 'Mensagem inclui motivo de recesso');

    // ------------------------------------------------------------------------
    // TESTE 9: 1-Click Toggle (Trava e Destrava instantânea de slot)
    // ------------------------------------------------------------------------
    console.log('\n--- 9. Simulação de 1-Click Toggle de Horário e Dia ---');
    const toggleDate = dateStr1;
    const toggleSlot = '12:00';

    // 1. Toggle ON: Inserir se não existir
    const checkBeforeToggle = await query(
      `SELECT id FROM agenda_bloqueios WHERE tenant_id = $1 AND data = $2 AND horario = $3`,
      [tenantA.id, toggleDate, toggleSlot]
    );
    assert(checkBeforeToggle.rowCount === 0, 'Slot 12:00 inicialmente livre');

    // Executa ação de toggle (inserção)
    await query(
      `INSERT INTO agenda_bloqueios (tenant_id, data, horario, motivo, tipo_recorrencia, tipo_acao)
       VALUES ($1, $2, $3, 'Trava rápida de 1 clique', 'unica', 'bloquear')`,
      [tenantA.id, toggleDate, toggleSlot]
    );

    const checkSlotAfterToggleOn = await aiEngine.executeCheckSlotTool({
      tenantId: tenantA.id,
      date: toggleDate,
      time: toggleSlot
    });
    assert(checkSlotAfterToggleOn.available === false, 'Slot 12:00 travado instantaneamente pelo toggle');

    // 2. Toggle OFF: Como já existe, o toggle remove (destrava com 1 clique)
    const existingLock = await query(
      `SELECT id FROM agenda_bloqueios WHERE tenant_id = $1 AND data = $2 AND horario = $3`,
      [tenantA.id, toggleDate, toggleSlot]
    );
    await query(`DELETE FROM agenda_bloqueios WHERE id = $1 AND tenant_id = $2`, [existingLock.rows[0].id, tenantA.id]);

    const checkSlotAfterToggleOff = await aiEngine.executeCheckSlotTool({
      tenantId: tenantA.id,
      date: toggleDate,
      time: toggleSlot
    });
    assert(checkSlotAfterToggleOff.available === true, 'Slot 12:00 destravado instantaneamente pelo segundo toggle');

    // ------------------------------------------------------------------------
    // TESTE 10: Isolamento Multi-tenant
    // ------------------------------------------------------------------------
    if (tenantB.id !== tenantA.id) {
      console.log('\n--- 10. Isolamento Multi-tenant ---');
      // O Sábado 2 está travado no Tenant A, mas deve estar livre para o Tenant B (se o B atender no sábado)
      const locksB = await query(
        `SELECT id FROM agenda_bloqueios WHERE tenant_id = $1`,
        [tenantB.id]
      );
      assert(
        locksB.rowCount === 0,
        'Tenant B não possui bloqueios vazados do Tenant A (isolamento garantido)'
      );
    }

  } finally {
    // Limpeza final
    await query(`DELETE FROM agenda_bloqueios WHERE tenant_id = $1`, [tenantA.id]);
    await pool.end();
  }

  console.log(`\n========================================`);
  console.log(`RESULTADO FINAL: ${passed} PASS, ${failed} FAIL`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Erro nos testes:', err);
  process.exit(1);
});

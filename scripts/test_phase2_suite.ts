// ==============================================================================
// SAAS MULTI-TENANT ENGINE - PHASE 2 TEST SUITE (TYPESCRIPT)
// Comprehensive automated test verifying:
// 1. Multi-Tenant Auto-Registration & Bcrypt hashing
// 2. JWT authentication & tenant context verification
// 3. Customer Profile & Cumulative Dossier (long-term memory)
// 4. Appointments & Service Orders linking
// 5. Strict multi-tenant data isolation (cross-tenant leakage check)
// 6. Foreign key cascade deletion
// ==============================================================================

import { query, shutdownPool } from '../src/database/db';
import { AuthService } from '../src/services/auth.service';
import { CustomerService } from '../src/services/customer.service';

async function runTestSuite() {
  console.log('================================================================');
  console.log('🧪 INICIANDO BATERIA DE TESTES DE INTEGRAÇÃO - FASE 2 (TYPESCRIPT)');
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
    // Teste 1: Auto-cadastro de Tenant A + Administrador com Bcrypt
    // --------------------------------------------------------------------------
    console.log('📋 Teste 1: Auto-cadastro de Tenant e Usuário Admin (Bcrypt + JWT)');
    const tenantAEmail = `admin.test.${Date.now()}@alphacorp.com`;
    const regResultA = await AuthService.registerTenantAndAdmin({
      nome_empresa: 'Alpha Corp Automação',
      documento: '12.345.678/0001-90',
      plano: 'pro',
      nome: 'Carlos Gestor',
      email: tenantAEmail,
      password: 'SenhaUltraForte123!',
      sobre_empresa: 'Empresa especializada em segurança eletrônica e CFTV residencial.'
    });

    assert(Boolean(regResultA.tenant.id), 'Tenant A criado com UUID válido');
    assert(regResultA.tenant.nome_empresa === 'Alpha Corp Automação', 'Nome da empresa gravado corretamente');
    assert(regResultA.user.email === tenantAEmail, 'E-mail do administrador normalizado e gravado');
    assert(regResultA.user.role === 'admin', 'Role inicial do usuário é "admin"');
    assert(Boolean(regResultA.token), 'Token JWT gerado no auto-cadastro');

    // --------------------------------------------------------------------------
    // Teste 2: Validação de Senha Criptografada e Login
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 2: Login com Validação de Senha (Hash Bcrypt)');
    const loginOk = await AuthService.login({
      email: tenantAEmail,
      password: 'SenhaUltraForte123!'
    });
    assert(loginOk.user.id === regResultA.user.id, 'Login autenticado com sucesso');

    let loginFailCaught = false;
    try {
      await AuthService.login({
        email: tenantAEmail,
        password: 'SenhaErrada123'
      });
    } catch {
      loginFailCaught = true;
    }
    assert(loginFailCaught, 'Login rejeitado com senha incorreta');

    const decoded = AuthService.verifyToken(loginOk.token);
    assert(decoded !== null, 'Token JWT é válido e verificável');
    assert(decoded?.tenantId === regResultA.tenant.id, 'Token JWT contém tenantId correto');
    assert(decoded?.role === 'admin', 'Token JWT contém role correto');

    // --------------------------------------------------------------------------
    // Teste 3: Dossiê Permanente do Cliente (Memória de Longo Prazo)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 3: Dossiê Cumulativo de Contato (Customer Profile)');
    const remoteJidTest = '5531988887777@s.whatsapp.net';
    const profile = await CustomerService.findOrCreateProfile(
      regResultA.tenant.id,
      remoteJidTest,
      {
        nome: 'Dona Maria Síndica',
        telefone: '5531988887777',
        endereco_completo: 'Rua das Flores, 120, Apto 501 - Savassi, BH'
      }
    );
    assert(Boolean(profile.id), 'Perfil do cliente criado com UUID');
    assert(profile.nome === 'Dona Maria Síndica', 'Nome do cliente gravado');

    // Adiciona notas cumulativas ao dossiê
    const updatedProfile = await CustomerService.appendToDossier(
      regResultA.tenant.id,
      remoteJidTest,
      'Cliente tem 16 câmeras analógicas instaladas no condomínio e quer migrar para IP Intelbras.',
      { tipo_imovel: 'condominio', num_cameras: 16 }
    );
    assert(
      (updatedProfile.perfil_resumo || '').includes('16 câmeras analógicas'),
      'Nota cumulativa persistida no campo perfil_resumo'
    );
    assert(
      (updatedProfile.metadados as any).tipo_imovel === 'condominio',
      'Metadados estruturados gravados em JSONB'
    );

    // --------------------------------------------------------------------------
    // Teste 4: Agendamento Vinculado ao Dossiê do Cliente
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 4: Histórico de Agendamento e Ordens de Serviço');
    const appointmentDate = new Date(Date.now() + 86400000 * 3); // 3 dias no futuro
    const appointment = await CustomerService.createAppointment(
      regResultA.tenant.id,
      {
        remote_jid: remoteJidTest,
        servico: 'Vistoria Técnica de CFTV',
        data_agendada: appointmentDate,
        status: 'agendado',
        valor_estimado: 250.00,
        observacoes: 'Tocar interfone 501. Cão dócil no local.'
      }
    );
    assert(Boolean(appointment.id), 'Agendamento criado com sucesso');
    assert(appointment.customer_id === profile.id, 'Agendamento vinculado ao customer_id do dossiê');
    assert(Number(appointment.valor_estimado) === 250.00, 'Valor estimado gravado');

    // --------------------------------------------------------------------------
    // Teste 5: Isolamento Estrito Multi-Tenant (Cross-Tenant Leakage Check)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 5: Isolamento Estrito Multi-Tenant (Segurança)');
    const tenantBEmail = `admin.test.${Date.now()}@betaseg.com`;
    const regResultB = await AuthService.registerTenantAndAdmin({
      nome_empresa: 'Beta Segurança Eletrônica',
      documento: '98.765.432/0001-10',
      plano: 'start',
      nome: 'Juliana Diretora',
      email: tenantBEmail,
      password: 'SenhaForteBeta999!',
      sobre_empresa: 'Empresa concorrente atuando em alarmes e monitoramento.'
    });

    // O mesmo número de WhatsApp entra em contato com o Tenant B
    const profileTenantB = await CustomerService.findOrCreateProfile(
      regResultB.tenant.id,
      remoteJidTest, // Mesmo remote_jid!
      {
        nome: 'Maria (Lead Beta)',
        telefone: '5531988887777',
        endereco_completo: 'Outro endereço informado'
      }
    );

    assert(profileTenantB.id !== profile.id, 'Perfis de clientes são isolados por tenant_id mesmo com mesmo WhatsApp');
    assert(profileTenantB.perfil_resumo === null, 'Tenant B não tem acesso ao dossiê confidencial do Tenant A');

    // Verifica que o Tenant B não visualiza agendamentos do Tenant A
    const historyB = await CustomerService.getCustomerHistory(regResultB.tenant.id, remoteJidTest);
    assert(historyB.appointments.length === 0, 'Tenant B não enxerga agendamentos do Tenant A (Zero Leakage)');

    const historyA = await CustomerService.getCustomerHistory(regResultA.tenant.id, remoteJidTest);
    assert(historyA.appointments.length === 1, 'Tenant A mantém seus agendamentos intactos');

    // --------------------------------------------------------------------------
    // Teste 6: Deleção em Cascata (ON DELETE CASCADE)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 6: Deleção em Cascata (Limpeza de Dados e Integridade)');
    await query('DELETE FROM tenants WHERE id = $1;', [regResultB.tenant.id]);

    const usersBAfterDelete = await query('SELECT id FROM users WHERE tenant_id = $1;', [regResultB.tenant.id]);
    assert(usersBAfterDelete.rows.length === 0, 'Usuários do Tenant B deletados em cascata');

    const profilesBAfterDelete = await query('SELECT id FROM customer_profiles WHERE tenant_id = $1;', [regResultB.tenant.id]);
    assert(profilesBAfterDelete.rows.length === 0, 'Customer profiles do Tenant B deletados em cascata');

    // Limpa tenant A de teste
    await query('DELETE FROM tenants WHERE id = $1;', [regResultA.tenant.id]);

    console.log('\n================================================================');
    console.log(`🎉 TODAS AS VALIDAÇÕES DA FASE 2 FORAM CONCLUÍDAS COM SUCESSO!`);
    console.log(`Total de Testes: ${totalTests} | Aprovados: ${passedTests} | Falhas: 0`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('❌ Falha na bateria de testes:', err);
    throw err;
  } finally {
    await shutdownPool();
  }
}

runTestSuite()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));

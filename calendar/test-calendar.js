// ==============================================================================
// Script de Teste e Validação do Google Calendar
// ==============================================================================

const calendarService = require('./google-calendar');

async function main() {
  console.log('==========================================================');
  console.log('       Teste de Conexão com Google Calendar API           ');
  console.log('==========================================================');

  const ready = await calendarService.init();
  if (!ready) {
    console.log('\n[AVISO] Para ativar a conexão com o Google Agenda:');
    console.log('1. Salve o arquivo "google-credentials.json" na pasta raiz do projeto:');
    console.log('   D:\\Projetos\\evolution\\google-credentials.json');
    console.log('2. Configure no seu .env:');
    console.log('   GOOGLE_CALENDAR_ID=seu-email@gmail.com');
    console.log('3. Compartilhe sua agenda no Google Calendar com o e-mail da Service Account.\n');
    return;
  }

  const hoje = new Date().toISOString().split('T')[0];
  console.log(`\nConsultando disponibilidade para a data: ${hoje}...`);
  try {
    const avail = await calendarService.getDayAvailability(hoje);
    console.log('Resultado da Agenda:');
    console.log(`- Horários Livres: ${avail.availableSlots.join(', ') || 'Nenhum'}`);
    console.log(`- Horários Ocupados: ${avail.busySlots.join(', ') || 'Nenhum'}`);
  } catch (err) {
    console.error('Erro na consulta:', err.message);
  }
}

main();

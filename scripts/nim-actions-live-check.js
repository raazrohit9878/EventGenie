require('dotenv').config();
const { createNimCompletion, isNimConfigured } = require('../server/nvidia');
const { PORTAL_CHANGE_TOOL, buildMessages } = require('../server/chat');
const { buildPortalChange, clarifyPortalChange } = require('../server/actions');

const workspace = {
  event: {
    name: 'NIM tool check',
    type: 'Wedding',
    date: '2027-06-12',
    location: 'Jaipur',
    guests: 80,
    budget: 500000,
    currency: '₹',
    theme: '',
    venue: '',
    dietary: '',
    priorities: '',
  },
  expenses: [],
  tasks: [],
  vendors: [],
  guests: [],
};

(async () => {
  if (!isNimConfigured()) {
    console.error(
      'Live NIM action check skipped: configure NVIDIA_API_KEY and NVIDIA_MODEL in the backend .env first.',
    );
    process.exitCode = 2;
    return;
  }
  const result = await createNimCompletion({
    tools: [PORTAL_CHANGE_TOOL],
    timeoutMs: 80000,
    messages: [
      {
        role: 'system',
        content:
          'This is a live function-calling check. The user clearly requests one action. Call propose_portal_change with entity task, action create, data title "Confirm the caterer", category Catering, due "2027-05-01", priority High.',
      },
      { role: 'user', content: 'Add a high priority task to confirm the caterer, due 2027-05-01.' },
    ],
  });
  if (!result.ok) {
    console.error(`NIM tool check failed (${result.code}): ${result.error}`);
    process.exitCode = 1;
    return;
  }
  const proposal = buildPortalChange(result.toolCall, workspace);
  if (!proposal) {
    console.error('NIM responded but did not return a valid portal-change function call.');
    process.exitCode = 1;
    return;
  }
  console.log(
    `NIM portal-action check succeeded. Model: ${result.model}. Validated proposal: ${proposal.summary}.`,
  );
  const birthday = await createNimCompletion({
    tools: [PORTAL_CHANGE_TOOL],
    timeoutMs: 80000,
    messages: buildMessages({
      workspace,
      history: [],
      userMessage: 'Create to organise a birthday party.',
      proposal: null,
    }),
  });
  if (!birthday.ok) {
    console.error(`Birthday follow-up check failed (${birthday.code}): ${birthday.error}`);
    process.exitCode = 1;
    return;
  }
  const birthdayAction = buildPortalChange(birthday.toolCall, workspace);
  const followUp = birthdayAction
    ? birthdayAction.summary
    : birthday.content || clarifyPortalChange(birthday.toolCall, workspace);
  if (!followUp || followUp.includes('I could not safely prepare that change')) {
    console.error('Birthday request did not produce a useful response or safe event proposal.');
    process.exitCode = 1;
    return;
  }
  console.log(
    `Birthday request check succeeded. ${String(followUp).replace(/\s+/g, ' ').slice(0, 260)}`,
  );
})().catch((err) => {
  console.error(`NIM tool check failed: ${err.message}`);
  process.exitCode = 1;
});

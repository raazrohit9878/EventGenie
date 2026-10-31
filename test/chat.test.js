const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventContext, parseProposal, buildMessages, normalizeAssistantReply } = require('../server/chat');

function workspace() {
  return {
    event: { name: 'A celebration', type: 'Wedding', date: '2026-12-12', location: 'Jaipur', guests: 120, budget: 100000, currency: '₹', theme: 'Garden', venue: 'Outdoor', dietary: 'Vegetarian', priorities: 'Accessible seating' },
    expenses: [{ name: 'Food', category: 'Catering', planned: 40000, actual: 5000 }],
    tasks: [{ title: 'Book the venue', category: 'Venue', due: '2026-11-10', priority: 'High', status: 'In progress' }],
    vendors: [{ name: 'Sample Caterer', category: 'Catering', contact: 'private@example.test', quote: 40000, status: 'Quote received' }],
    guests: [{ name: 'Private Guest', contact: 'guest@example.test', rsvp: 'Yes', dietary: 'Vegan' }]
  };
}

test('chat receives scoped event context and omits guest/vendor contact details', () => {
  const context = eventContext(workspace());
  assert.equal(context.event.guest_count, 120);
  assert.equal(context.expenses.planned_total, 40000);
  assert.equal(context.tasks[0].status, 'In progress');
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('private@example.test'), false);
  assert.equal(serialized.includes('guest@example.test'), false);
});

test('safe proposal parser extracts budget and guest targets without applying them', () => {
  const w = workspace();
  assert.deepEqual(parseProposal('Reduce my budget to ₹80,000.', w), { type: 'adjust_budget', from: 100000, to: 80000, currency: '₹' });
  assert.deepEqual(parseProposal('Increase my guest count from 100 to 200.', w), { type: 'adjust_guests', from: 120, to: 200 });
  assert.equal(parseProposal('What is my current budget?', w), null);
  assert.equal(w.event.budget, 100000, 'parsing a request never mutates the saved plan');
});

test('NIM messages contain backend system rules, event context, and bounded history', () => {
  const result = buildMessages({ workspace: workspace(), history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }], userMessage: 'What tasks are pending?', proposal: null });
  assert.equal(result[0].role, 'system');
  assert.match(result[0].content, /Never claim a plan was saved or changed/);
  assert.match(result[0].content, /Jaipur/);
  assert.deepEqual(result.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(result.at(-1).content, 'What tasks are pending?');
  assert.match(result[0].content, /Do not output source code, JSON, schema, tool-call syntax/);
  const actionMessages = buildMessages({ workspace: workspace(), history: [], userMessage: 'Update the event theme.', proposal: null, allowActions: true });
  assert.match(actionMessages[0].content, /Never print the tool name, arguments, JSON, or code/);
});

test('chat reply formatter converts fenced JSON into readable text and blocks source-code-shaped replies', () => {
  const formatted = normalizeAssistantReply('```json\n{"overview":"Birthday party","tasks":["Book a venue","Order cake"]}\n```');
  assert.match(formatted, /Overview/);
  assert.match(formatted, /Birthday party/);
  assert.match(formatted, /Book a venue/);
  assert.equal(formatted.includes('```'), false);
  assert.match(normalizeAssistantReply('const x = 1;'), /event-planning answer/);
  assert.match(normalizeAssistantReply('```javascript\nconst x = 1;\n```'), /event-planning answer/);
  assert.equal(normalizeAssistantReply('Try warm lights and reusable decorations.'), 'Try warm lights and reusable decorations.');
});

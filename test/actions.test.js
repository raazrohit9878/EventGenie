const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPortalChange, applyPortalChange, clarifyPortalChange, extractEventCreationData, parseDirectPortalChange, shouldEnablePortalTool } = require('../server/actions');

function workspace() {
  return {
    event: { name: 'A celebration', type: 'Wedding', date: '2026-12-12', location: 'Jaipur', guests: 120, budget: 100000, currency: '₹', theme: 'Garden', venue: 'Outdoor', dietary: 'Vegetarian', priorities: '' },
    expenses: [{ id: 1, name: 'Food', category: 'Catering', planned: 40000, actual: 5000 }],
    tasks: [{ id: 2, title: 'Book venue', category: 'Venue', due: '2026-11-10', priority: 'High', status: 'In progress' }],
    vendors: [{ id: 3, name: 'Sample Caterer', category: 'Catering', quote: 40000, status: 'Quote received', location: 'Jaipur', notes: '' }],
    guests: [{ id: 4, name: 'Private Guest', contact: 'guest@example.test', rsvp: 'Pending', dietary: 'None' }]
  };
}

test('portal change validator builds allowlisted event, task, expense, vendor, and guest proposals', () => {
  const w = workspace();
  assert.equal(buildPortalChange({ entity: 'event', action: 'update', data: { theme: 'Royal garden', ignored: 'secret' } }, w).fields.ignored, undefined);
  assert.equal(buildPortalChange({ entity: 'task', action: 'create', data: { title: 'Confirm menu', due: '2026-11-20', priority: 'High' } }, w).fields.status, 'Not started');
  assert.equal(buildPortalChange({ entity: 'expense', action: 'create', data: { name: 'Lighting', category: 'Decoration', planned: 25000 } }, w).fields.actual, 0);
  assert.equal(buildPortalChange({ entity: 'vendor', action: 'update', target: 'Sample Caterer', data: { status: 'Booked' } }, w).fields.status, 'Booked');
  assert.equal(buildPortalChange({ entity: 'guest', action: 'create', data: { name: 'Guest One' } }, w).fields.rsvp, 'Pending');
  assert.equal(buildPortalChange({ entity: 'task', action: 'create', data: { title: 'Invalid date', due: '2027-01-01' } }, w), null);
  assert.equal(buildPortalChange({ entity: 'vendor', action: 'update', target: 'unknown', data: { status: 'Booked' } }, w), null);
  assert.equal(buildPortalChange({ entity: 'vendor', action: 'delete', target: 'Sample Caterer' }, w).summary, 'Remove vendor: Sample Caterer');
  assert.equal(buildPortalChange({ entity: 'guest', action: 'update', target: 'Private Guest', data: { rsvp: 'Yes' } }, w).fields.rsvp, 'Yes');
  assert.equal(buildPortalChange({ entity: 'guest', action: 'delete', target: 'Private Guest' }, w).summary, 'Remove guest: Private Guest');
});

test('portal changes apply only to matching workspace data and rebalance a changed budget', () => {
  const w = workspace();
  const theme = buildPortalChange({ entity: 'event', action: 'update', data: { theme: 'Royal garden' } }, w);
  applyPortalChange(w, theme);
  assert.equal(w.event.theme, 'Royal garden');
  const budget = buildPortalChange({ entity: 'event', action: 'update', data: { budget: 80000 } }, w);
  applyPortalChange(w, budget);
  assert.equal(w.event.budget, 80000);
  assert.equal(w.expenses.reduce((n, x) => n + x.planned, 0), 80000);
  const task = buildPortalChange({ entity: 'task', action: 'create', data: { title: 'Confirm menu', due: '2026-11-20' } }, w);
  applyPortalChange(w, task);
  assert.equal(w.tasks.length, 2);
  const remove = buildPortalChange({ entity: 'task', action: 'delete', target: 'Book venue' }, w);
  applyPortalChange(w, remove);
  assert.equal(w.tasks.some(x => x.title === 'Book venue'), false);
});

test('incomplete birthday planning requests receive event-specific clarification instead of a generic validation error', () => {
  const w = workspace();
  const birthday = clarifyPortalChange({ entity: 'event', action: 'create', data: { type: 'Birthday' } }, w);
  assert.match(birthday, /birthday/);
  assert.match(birthday, /party date/);
  assert.match(birthday, /approximate guest count/);
  const task = clarifyPortalChange({ entity: 'task', action: 'create', data: { title: 'Organise birthday party' } }, w);
  assert.match(task, /What due date should I use\?/);
  assert.match(task, /won’t guess a deadline/);
});

test('a confirmed new-event proposal creates a clean workspace and warns that the active plan is replaced', () => {
  const w = workspace();
  const proposal = buildPortalChange({ entity: 'event', action: 'create', data: { type: 'Birthday', date: '2027-05-01', location: 'Jaipur', guests: 30, budget: 50000 } }, w);
  assert.match(proposal.summary, /replaces the active event/);
  applyPortalChange(w, proposal);
  assert.equal(w.event.type, 'Birthday');
  assert.equal(w.event.name, 'Birthday celebration');
  assert.equal(w.tasks.length, 0);
  assert.equal(w.expenses.length, 0);
  assert.equal(w.vendors.length, 0);
  assert.equal(w.guests.length, 0);
});

test('birthday follow-up answers are accumulated across turns instead of asking for the same field again', () => {
  const history = [
    { role: 'user', content: 'Create to organise a birthday party.' },
    { role: 'assistant', content: 'Sure, I can set this up. Please share the approximate guest count and budget.' },
    { role: 'user', content: 'Date 2026-12-20, location Jaipur.' },
    { role: 'user', content: 'budget 50000, guest count 50, select by yourself' },
    { role: 'assistant', content: 'Please share the party date and location.' }
  ];
  const data = extractEventCreationData(history, '50 members');
  assert.equal(data.type, 'Birthday');
  assert.equal(data.date, '2026-12-20');
  assert.equal(data.location, 'Jaipur');
  assert.equal(data.budget, 50000);
  assert.equal(data.guests, 50);
  assert.ok(buildPortalChange({ entity: 'event', action: 'create', data }, workspace()));
});

test('clear English and Hinglish commands map to validated portal changes without a model guessing the target', () => {
  const w = workspace();
  assert.equal(parseDirectPortalChange('Add a high priority task called Confirm the birthday cake, due 2026-11-30.', w).fields.title, 'Confirm the birthday cake');
  assert.equal(parseDirectPortalChange('Mark Sample Caterer as Booked.', w).fields.status, 'Booked');
  assert.equal(parseDirectPortalChange('Private Guest ka RSVP Yes mark karo.', w).fields.rsvp, 'Yes');
  assert.equal(parseDirectPortalChange('Change my theme to a colorful garden party.', w).fields.theme, 'a colorful garden party');
  assert.equal(parseDirectPortalChange('Should Private Guest RSVP Yes?', w), null);
  assert.equal(parseDirectPortalChange('Add a caterer named Celebration Bites quote ₹35,000 location Jaipur.', w).fields.quote, 35000);
  assert.equal(parseDirectPortalChange('Add guest named Mira Kapoor RSVP Yes dietary vegan.', w).fields.dietary, 'vegan');
  assert.equal(parseDirectPortalChange('Add an expense called Lighting for ₹25,000.', w).fields.planned, 25000);
  assert.equal(parseDirectPortalChange('What should my theme be?', w), null);
  assert.equal(shouldEnablePortalTool('What tasks are pending?'), false);
  assert.equal(shouldEnablePortalTool('Suggest three birthday decoration ideas.'), false);
  assert.equal(shouldEnablePortalTool('Update the vendor status.'), true);
});

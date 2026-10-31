const EVENT_FIELDS = new Set(['name', 'type', 'date', 'time', 'location', 'guests', 'budget', 'currency', 'theme', 'venue', 'venueTier', 'dietary', 'cateringNotes', 'priorities']);
const TASK_FIELDS = new Set(['title', 'category', 'due', 'priority', 'status', 'assigned']);
const EXPENSE_FIELDS = new Set(['name', 'category', 'planned', 'actual']);
const VENDOR_FIELDS = new Set(['name', 'category', 'location', 'quote', 'status', 'notes', 'contact']);
const GUEST_FIELDS = new Set(['name', 'contact', 'category', 'rsvp', 'dietary']);
const EVENT_TYPES = new Set(['Wedding', 'Birthday', 'Anniversary', 'Baby shower', 'College festival', 'Community gathering', 'Corporate event', 'Custom event']);
const PRIORITIES = new Set(['High', 'Medium', 'Low']);
const TASK_STATUSES = new Set(['Not started', 'In progress', 'Completed', 'Blocked']);
const VENDOR_STATUSES = new Set(['Shortlisted', 'Contacted', 'Quote received', 'Booked', 'Declined']);
const RSVP_STATUSES = new Set(['Pending', 'Yes', 'No']);
const EXPENSE_CATEGORIES = new Set(['Venue', 'Catering', 'Decoration', 'Photography', 'Entertainment', 'Transportation', 'Invitations', 'Clothing', 'Accommodation', 'Miscellaneous']);
const VENDOR_CATEGORIES = new Set(['Venue', 'Catering', 'Photographer', 'Decorator', 'Florist', 'DJ', 'Entertainment', 'Transportation', 'Accommodation', 'Other']);
const dateOk = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const text = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const amount = value => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1e12 ? Number(value) : null;
const safeFields = (data, whitelist) => data && typeof data === 'object' && !Array.isArray(data) ? Object.fromEntries(Object.entries(data).filter(([key]) => whitelist.has(key))) : {};

function buildPortalChange(candidate, workspace) {
  if (!candidate || typeof candidate !== 'object' || !['event', 'task', 'expense', 'vendor', 'guest'].includes(candidate.entity) || !['create', 'update', 'delete'].includes(candidate.action)) return null;
  const entity = candidate.entity;
  const target = text(candidate.target, 120) || '';
  const data = candidate.data && typeof candidate.data === 'object' && !Array.isArray(candidate.data) ? candidate.data : {};
  if (candidate.action === 'delete') {
    if (!['task', 'expense', 'vendor', 'guest'].includes(entity) || !target) return null;
    const items = entity === 'task' ? workspace.tasks : entity === 'expense' ? workspace.expenses : entity === 'vendor' ? workspace.vendors : workspace.guests;
    const key = entity === 'task' ? 'title' : 'name';
    if (items.filter(item => item[key].toLowerCase() === target.toLowerCase()).length !== 1) return null;
    const label = entity === 'task' ? 'task' : entity;
    return { type: 'portal_change', entity, operation: 'delete', target, fields: {}, summary: `Remove ${label}: ${target}` };
  }
  let fields;
  if (entity === 'event') {
    fields = safeFields(data, EVENT_FIELDS);
    if (candidate.action === 'create') {
      if (!EVENT_TYPES.has(fields.type)) return null;
      fields.name = text(fields.name, 120) || `${fields.type} celebration`;
      fields.location = text(fields.location, 140);
      const guests = amount(fields.guests), budget = amount(fields.budget);
      if (!dateOk(fields.date) || !fields.location || !Number.isInteger(guests) || guests < 1 || guests > 100000 || !budget || budget <= 0) return null;
      fields.guests = guests; fields.budget = budget; fields.currency = text(fields.currency, 8) || workspace.event.currency || '₹';
      fields.theme = text(fields.theme, 120) || ''; fields.venue = text(fields.venue, 120) || '';
      fields.time = text(fields.time, 40) || ''; fields.venueTier = text(fields.venueTier, 80) || '';
      fields.dietary = text(fields.dietary, 240) || ''; fields.cateringNotes = text(fields.cateringNotes, 240) || ''; fields.priorities = text(fields.priorities, 300) || '';
    } else {
      if (candidate.action !== 'update') return null;
      if (!Object.keys(fields).length) return null;
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'name' && !(fields[key] = text(value, 120))) return null;
        if (key === 'type' && !(EVENT_TYPES.has(value) && value)) return null;
        if (key === 'date' && (!dateOk(value) || workspace.tasks.some(t => t.due > value))) return null;
        if (key === 'time' && !(fields[key] = text(value, 40))) return null;
        if (key === 'location' && !(fields[key] = text(value, 140))) return null;
        if (key === 'guests') { const n = amount(value); if (!Number.isInteger(n) || n < 1 || n > 100000) return null; fields[key] = n; }
        if (key === 'budget') { const n = amount(value); if (!n || n <= 0) return null; fields[key] = n; }
        if (key === 'currency' && !(fields[key] = text(value, 8))) return null;
        if (key === 'theme' && !(fields[key] = text(value, 120))) return null;
        if (key === 'venue' && !(fields[key] = text(value, 120))) return null;
        if (key === 'venueTier' && !(fields[key] = text(value, 80))) return null;
        if (key === 'dietary' && !(fields[key] = text(value, 240))) return null;
        if (key === 'cateringNotes' && !(fields[key] = text(value, 240))) return null;
        if (key === 'priorities' && !(fields[key] = text(value, 300))) return null;
      }
    }
  } else if (entity === 'task') {
    fields = safeFields(data, TASK_FIELDS);
    if (candidate.action === 'create') {
      fields.title = text(fields.title, 180);
      fields.category = text(fields.category, 60) || 'Planning';
      if (!fields.title || !dateOk(fields.due) || fields.due > workspace.event.date) return null;
      if (fields.priority && !PRIORITIES.has(fields.priority)) return null;
      if (fields.status && !TASK_STATUSES.has(fields.status)) return null;
      fields.priority ||= 'Medium'; fields.status ||= 'Not started'; fields.assigned = text(fields.assigned, 80) || '';
    } else {
      const found = workspace.tasks.filter(t => t.title.toLowerCase() === target.toLowerCase());
      if (!target || found.length !== 1 || !Object.keys(fields).length) return null;
      if ('title' in fields && !(fields.title = text(fields.title, 180))) return null;
      if ('category' in fields && !(fields.category = text(fields.category, 60))) return null;
      if ('due' in fields && (!dateOk(fields.due) || fields.due > workspace.event.date)) return null;
      if ('priority' in fields && !PRIORITIES.has(fields.priority)) return null;
      if ('status' in fields && !TASK_STATUSES.has(fields.status)) return null;
      if ('assigned' in fields && !(fields.assigned = text(fields.assigned, 80))) return null;
    }
  } else if (entity === 'expense') {
    fields = safeFields(data, EXPENSE_FIELDS);
    if (candidate.action === 'create') {
      fields.name = text(fields.name, 120); fields.category = fields.category || 'Miscellaneous';
      const n = amount(fields.planned);
      if (!fields.name || !EXPENSE_CATEGORIES.has(fields.category) || n === null) return null;
      fields.planned = n; fields.actual = 0;
    } else {
      const found = workspace.expenses.filter(x => x.name.toLowerCase() === target.toLowerCase());
      if (!target || found.length !== 1 || !Object.keys(fields).length) return null;
      if ('name' in fields && !(fields.name = text(fields.name, 120))) return null;
      if ('category' in fields && !EXPENSE_CATEGORIES.has(fields.category)) return null;
      for (const key of ['planned', 'actual']) if (key in fields) { const n = amount(fields[key]); if (n === null) return null; fields[key] = n; }
    }
  } else if (entity === 'vendor') {
    fields = safeFields(data, VENDOR_FIELDS);
    if (candidate.action === 'create') {
      fields.name = text(fields.name, 160); fields.category ||= 'Other'; fields.location = text(fields.location, 120) || '';
      const quote = amount(fields.quote ?? 0);
      if (!fields.name || !VENDOR_CATEGORIES.has(fields.category) || quote === null) return null;
      fields.quote = quote; fields.status ||= 'Shortlisted';
      if (!VENDOR_STATUSES.has(fields.status)) return null;
      fields.notes = text(fields.notes, 200) || ''; fields.contact = text(fields.contact, 160) || '';
    } else {
      const found = workspace.vendors.filter(x => x.name.toLowerCase() === target.toLowerCase());
      if (!target || found.length !== 1 || !Object.keys(fields).length) return null;
      if ('name' in fields && !(fields.name = text(fields.name, 160))) return null;
      if ('category' in fields && !VENDOR_CATEGORIES.has(fields.category)) return null;
      for (const key of ['location', 'notes', 'contact']) if (key in fields && !(fields[key] = text(fields[key], key === 'notes' ? 200 : 160))) return null;
      if ('quote' in fields) { const n = amount(fields.quote); if (n === null) return null; fields.quote = n; }
      if ('status' in fields && !VENDOR_STATUSES.has(fields.status)) return null;
    }
  } else {
    fields = safeFields(data, GUEST_FIELDS);
    if (candidate.action === 'create') {
      fields.name = text(fields.name, 120); fields.contact = text(fields.contact, 160) || ''; fields.category = text(fields.category, 60) || 'Other'; fields.rsvp ||= 'Pending'; fields.dietary = text(fields.dietary, 120) || 'None';
      if (!fields.name || !RSVP_STATUSES.has(fields.rsvp)) return null;
    } else {
      const found = workspace.guests.filter(x => x.name.toLowerCase() === target.toLowerCase());
      if (!target || found.length !== 1 || !Object.keys(fields).length) return null;
      if ('name' in fields && !(fields.name = text(fields.name, 120))) return null;
      if ('contact' in fields && !(fields.contact = text(fields.contact, 160))) return null;
      if ('category' in fields && !(fields.category = text(fields.category, 60))) return null;
      if ('dietary' in fields && !(fields.dietary = text(fields.dietary, 120))) return null;
      if ('rsvp' in fields && !RSVP_STATUSES.has(fields.rsvp)) return null;
    }
  }
  const verb = entity === 'event' && candidate.action === 'create' ? 'Create new event' : candidate.action === 'create' ? 'Add' : 'Update';
  const label = { event: 'event details', task: 'task', expense: 'expense', vendor: 'vendor', guest: 'guest' }[entity];
  const detail = candidate.action === 'update' ? `${target}: ${Object.entries(fields).map(([k, v]) => `${k} → ${v}`).join(', ')}` : entity === 'event' ? `${fields.name} (${fields.type}), ${fields.date}${fields.time ? ` at ${fields.time}` : ''}, ${fields.location}, ${fields.guests} guests, ${fields.currency}${fields.budget.toLocaleString('en-IN')} total (${fields.currency}${Math.round(fields.budget / fields.guests).toLocaleString('en-IN')} per person)${fields.venue ? `, venue: ${fields.venue}` : ''}${fields.venueTier ? `, ${fields.venueTier} venue tier` : ''}${fields.theme ? `, theme: ${fields.theme}` : ''}${fields.dietary ? `, dietary: ${fields.dietary}` : ''}${fields.cateringNotes ? `, catering: ${fields.cateringNotes}` : ''}${fields.priorities ? `, priorities/accessibility: ${fields.priorities}` : ''}. Confirming replaces the active event and clears its tasks, expenses, vendors, guest list, and saved ideas.` : `${fields.name || fields.title}${fields.due ? `, due ${fields.due}` : ''}`;
  const summary = entity === 'event' && candidate.action === 'create' ? `${verb}: ${detail}` : `${verb} ${label}: ${detail}`;
  return { type: 'portal_change', entity, operation: candidate.action, target, fields, summary };
}

function applyPortalChange(workspace, proposal) {
  if (!proposal || proposal.type !== 'portal_change') throw new Error('Unsupported portal change.');
  const { entity, operation, target, fields } = proposal;
  if (entity === 'event') {
    if (!fields || Object.keys(fields).some(k => !EVENT_FIELDS.has(k))) throw new Error('Invalid event change.');
    if (operation === 'create') {
      workspace.event = { ...fields };
      workspace.tasks = []; workspace.expenses = []; workspace.vendors = []; workspace.guests = []; workspace.ideasSaved = [];
      return workspace;
    }
    if (operation !== 'update') throw new Error('Invalid event change.');
    Object.assign(workspace.event, fields);
    if ('budget' in fields) {
      const total = workspace.expenses.reduce((sum, x) => sum + Number(x.planned || 0), 0);
      let allocated = 0;
      workspace.expenses.forEach((x, i) => { x.planned = i === workspace.expenses.length - 1 ? 0 : total > 0 ? Math.round(Number(x.planned || 0) / total * fields.budget) : Math.floor(fields.budget / Math.max(1, workspace.expenses.length)); allocated += x.planned; });
      if (workspace.expenses.length) workspace.expenses.at(-1).planned += fields.budget - allocated;
    }
    return workspace;
  }
  if (entity === 'task') {
    if (operation === 'create') workspace.tasks.push({ id: Date.now(), ...fields });
    else { const found = workspace.tasks.filter(x => x.title.toLowerCase() === target.toLowerCase()); if (found.length !== 1) throw new Error('Task could not be uniquely matched.'); if (operation === 'delete') workspace.tasks = workspace.tasks.filter(x => x !== found[0]); else Object.assign(found[0], fields); }
  } else if (entity === 'expense') {
    if (operation === 'create') workspace.expenses.push({ id: Date.now(), ...fields });
    else { const found = workspace.expenses.filter(x => x.name.toLowerCase() === target.toLowerCase()); if (found.length !== 1) throw new Error('Expense could not be uniquely matched.'); if (operation === 'delete') workspace.expenses = workspace.expenses.filter(x => x !== found[0]); else Object.assign(found[0], fields); }
  } else if (entity === 'vendor') {
    if (operation === 'create') workspace.vendors.push({ id: Date.now(), ...fields });
    else { const found = workspace.vendors.filter(x => x.name.toLowerCase() === target.toLowerCase()); if (found.length !== 1) throw new Error('Vendor could not be uniquely matched.'); if (operation === 'delete') workspace.vendors = workspace.vendors.filter(x => x !== found[0]); else Object.assign(found[0], fields); }
  } else if (entity === 'guest') {
    if (operation === 'create') workspace.guests.push({ id: Date.now(), ...fields });
    else { const found = workspace.guests.filter(x => x.name.toLowerCase() === target.toLowerCase()); if (found.length !== 1) throw new Error('Guest could not be uniquely matched.'); if (operation === 'delete') workspace.guests = workspace.guests.filter(x => x !== found[0]); else Object.assign(found[0], fields); }
  }
  else throw new Error('Unsupported portal change.');
  return workspace;
}

function clarifyPortalChange(candidate, workspace) {
  if (!candidate || typeof candidate !== 'object') return '';
  const data = candidate.data && typeof candidate.data === 'object' ? candidate.data : {};
  if (candidate.entity === 'event' && candidate.action === 'create') {
    const missing = [];
    if (!EVENT_TYPES.has(data.type)) missing.push('the event type');
    if (!dateOk(data.date)) missing.push('the party date');
    if (!text(data.location, 140)) missing.push('the location');
    if (!Number.isInteger(amount(data.guests)) || amount(data.guests) < 1) missing.push('the approximate guest count');
    if (!amount(data.budget) || amount(data.budget) <= 0) missing.push('the budget');
    const recap = [`Event: ${data.type || 'not provided'}`, `Date: ${data.date || 'not provided'}${data.time ? ` at ${data.time}` : ''}`, `Location: ${data.location || 'not provided'}`, `Guests: ${data.guests || 'not provided'}`, `Budget: ${data.budget ? `${data.currency || '₹'}${Number(data.budget).toLocaleString('en-IN')}${data.guests ? ` (${data.currency || '₹'}${Math.round(data.budget / data.guests).toLocaleString('en-IN')} per person)` : ''}` : 'not provided'}`];
    if (data.venueTier) recap.push(`Venue tier: ${data.venueTier}`);
    if (data.theme) recap.push(`Theme: ${data.theme}`);
    if (data.cateringNotes) recap.push(`Catering: ${data.cateringNotes}`);
    if (data.dietary) recap.push(`Dietary: ${data.dietary}`);
    if (data.priorities) recap.push(`Priorities/accessibility: ${data.priorities}`);
    const luxuryConflict = data.venueTier && /luxury|5.star|premium/i.test(data.venueTier) && data.budget && data.guests;
    const feasibility = luxuryConflict ? `\nFeasibility note: ${data.currency || '₹'}${Math.round(data.budget / data.guests).toLocaleString('en-IN')} per person may constrain a ${data.venueTier} venue; actual costs depend on local quotations. A boutique venue or reducing decor scope could help.` : '';
    return `I’ve captured these details:\n${recap.map(line => `- ${line}`).join('\n')}${feasibility}\n${missing.length ? `I still need only: ${missing.join(', ')}.` : 'The required details are complete.'}${data.cateringNotes ? '' : '\nYou can optionally add a catering or menu preference.'}`;
  }
  if (candidate.entity === 'task' && candidate.action === 'create' && !dateOk(data.due)) {
    return `I can add that birthday-planning task. What due date should I use? The current event date is ${workspace.event.date || 'not set'}, and I won’t guess a deadline.`;
  }
  if (candidate.entity === 'expense' && candidate.action === 'create' && (text(data.name, 120) === null || amount(data.planned) === null)) {
    return 'I can add that expense. What should I call it, and what planned amount should I enter?';
  }
  if (candidate.entity === 'vendor' && candidate.action === 'create' && !text(data.name, 160)) {
    return 'I can add the vendor. What business name and service category should I use? You can also share its quote and location.';
  }
  if (candidate.entity === 'guest' && candidate.action === 'create' && !text(data.name, 120)) {
    return 'I can add the guest. What name should I put on the guest list? You can include RSVP and dietary details if you have them.';
  }
  if (candidate.action === 'update' && !text(candidate.target, 120)) {
    return 'Which saved item should I update? Please include its exact task, expense, vendor, or guest name and the change you want.';
  }
  return 'I can make that change, but I need one more detail to match it safely. Please name the item and the exact value you want changed.';
}

function isEventCreationIntent(value) {
  const hasEvent = /\b(birthday|wedding|anniversary|baby\s*shower|college|community|corporate|event|party|festival)\b/i.test(value);
  return hasEvent && (/\b(create|organis\w*|organiz\w*|set\s*up|arrange)\b/i.test(value) || /\bplan(?:ning)?\s+(?:a|an|my|the)?\s*(?:birthday|wedding|anniversary|event|party|festival)/i.test(value));
}

function shouldEnablePortalTool(value) {
  const message = String(value || '').trim();
  if (/^(?:what|how|why|when|where|which|who|suggest|recommend|compare|explain|what if|should i)\b/i.test(message)) return false;
  return /\b(add|create|update|change|set|mark|remove|delete|increase|reduce|decrease|book|cancel|rename|reschedule|organis\w*|organiz\w*|schedule)\b|\b(karo|kar do)\b/i.test(message);
}

function eventTypeFromText(value) {
  if (/\bbaby\s*shower\b/i.test(value)) return 'Baby shower';
  if (/\b(anniversary)\b/i.test(value)) return 'Anniversary';
  if (/\b(wedding|marriage)\b/i.test(value)) return 'Wedding';
  if (/\b(birthday)\b/i.test(value)) return 'Birthday';
  if (/\b(corporate|business|company)\b/i.test(value)) return 'Corporate event';
  if (/\b(college|campus|festival)\b/i.test(value)) return 'College festival';
  if (/\b(community|neighborhood)\b/i.test(value)) return 'Community gathering';
  return '';
}

function findEventTime(value) {
  const match = /\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(value);
  if (match) return `${match[1]}${match[2] ? `:${match[2]}` : ''} ${match[3].replace(/\./g, '').toUpperCase()}`;
  const twentyFour = /\b(?:at\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/.exec(value);
  return twentyFour ? `${twentyFour[1].padStart(2, '0')}:${twentyFour[2]}` : '';
}

function findEventDate(value) {
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(value);
  if (iso && dateOk(iso[1])) return iso[1];
  const textual = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i.exec(value)
    || /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/i.exec(value);
  if (textual) {
    const parsed = new Date(`${textual[0].replace(/(\d)(st|nd|rd|th)\b/i, '$1')} UTC`);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  const numeric = /\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/.exec(value);
  if (numeric) {
    const [, day, month, year] = numeric;
    const parsed = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    if (dateOk(parsed)) return parsed;
  }
  return '';
}

function findEventBudget(value, assistantAskedBudget) {
  const pattern = /(?:budget|spend(?:ing)?(?:\s+limit)?)\s*(?:is|of|:|=|to|around|about)?\s*(?:₹|rs\.?|inr|\$|€|£)?\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k|thousand|lakh|lakhs|lac|lacs|million|m)?/i;
  let match = pattern.exec(value);
  if (!match && assistantAskedBudget && /(?:₹|rs\.?|inr|\$|€|£)\s*[\d]/i.test(value)) match = /(?:₹|rs\.?|inr|\$|€|£)\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k|thousand|lakh|lakhs|lac|lacs|million|m)?/i.exec(value);
  if (!match) return null;
  const n = Number(match[1].replace(/,/g, ''));
  const suffix = (match[2] || '').toLowerCase();
  const factor = ['k', 'thousand'].includes(suffix) ? 1e3 : ['lakh', 'lakhs', 'lac', 'lacs'].includes(suffix) ? 1e5 : ['million', 'm'].includes(suffix) ? 1e6 : 1;
  const result = Math.round(n * factor);
  return Number.isFinite(result) && result > 0 && result <= 1e12 ? result : null;
}

function extractEventCreationData(history, currentMessage, fallbackType = '') {
  const rows = [...(Array.isArray(history) ? history : []), { role: 'user', content: currentMessage }];
  const userText = rows.filter(x => x.role === 'user').map(x => String(x.content || '')).join('\n');
  const lastAssistant = [...rows].reverse().find(x => x.role === 'assistant')?.content || '';
  const type = eventTypeFromText(userText) || (EVENT_TYPES.has(fallbackType) ? fallbackType : '');
  const askedGuests = /guest|attendee|people|member/i.test(lastAssistant);
  const guestsMatch = /(?:guest(?:s)?(?:\s+count)?|attendees|people|members|persons)\s*(?:count\s*)?(?:of|is|are|:|=)?\s*(\d[\d,]*)|\b(\d[\d,]*)\s*(?:guests|attendees|people|members|persons)\b/i.exec(userText) || (askedGuests ? /^\s*(\d[\d,]*)\s*$/m.exec(String(currentMessage || '')) : null);
  const guests = guestsMatch ? Number((guestsMatch[1] || guestsMatch[2]).replace(/,/g, '')) : null;
  const askedBudget = /budget|spending limit|spend limit/i.test(lastAssistant);
  const perHead = /(?:₹|rs\.?|inr)?\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k|thousand|lakh|lakhs|lac|lacs|million|m)?\s*(?:per\s*(?:person|head)|each|\/\s*(?:person|head))/i.exec(userText);
  const perHeadAmount = perHead ? findEventBudget(`budget ${perHead[1]}${perHead[2] || ''}`, true) : null;
  const budgetSearchText = perHead ? userText.replace(perHead[0], '') : userText;
  const explicitTotal = findEventBudget(budgetSearchText, askedBudget) || (!perHead && askedBudget && /^\s*(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:k|thousand|lakh|lakhs|lac|lacs|million|m)?\s*$/im.test(String(currentMessage || '')) ? findEventBudget(`budget ${String(currentMessage).trim()}`, true) : null);
  const date = findEventDate(userText);
  let location = '';
  const namedLocation = /\b(?:location|venue|place)\s*(?:is|:|=)?\s*([^,.;!?\n]+)/i.exec(userText);
  if (namedLocation) location = namedLocation[1].trim().replace(/^(?:in|at)\s+/i, '').split(/\s+(?:on|for|with|budget|guest count|guests|members|people|theme)\b/i)[0].trim();
  if (!location) {
    const inPlace = /\b(?:in|at)\s+([a-z][a-z .'-]{1,50}?)(?=\s+(?:on|for|with|budget|guests?|members|people|theme|venue)\b|[,.;!?\n]|$)/i.exec(userText);
    if (inPlace) location = inPlace[1].trim();
  }
  if (!location && /location|where|city/i.test(lastAssistant) && /^[a-z][a-z .'-]{1,50}$/i.test(String(currentMessage || '').trim()) && !/(select|choose|budget|guest|theme)\b/i.test(currentMessage)) location = String(currentMessage).trim();
  const time = findEventTime(userText);
  const namedTheme = /\btheme\s*(?:is|:|=|to)?\s*([^,.;!\n]+)/i.exec(userText)?.[1]?.trim();
  const venueTier = /\b(?:luxury|premium|5.star|boutique|budget-friendly)\s+(?:venue|banquet|hall|hotel)\b/i.exec(userText)?.[0] || '';
  const cateringNotes = /\b(?:all starter items|starters? only|no main course|vegetarian|vegan|halal|kosher|gluten.free|catering\s*(?:is|:|=)\s*[^,.;\n]+)/i.exec(userText)?.[0] || '';
  const guestsTotal = Number.isInteger(guests) && guests > 0 && guests <= 100000 ? guests : null;
  const budget = explicitTotal || (perHeadAmount && guestsTotal ? perHeadAmount * guestsTotal : null);
  const data = { type };
  if (type) data.name = `${type} celebration`;
  if (date) data.date = date;
  if (location) data.location = location.slice(0, 140);
  if (Number.isInteger(guests) && guests > 0 && guests <= 100000) data.guests = guests;
  if (budget) data.budget = budget;
  if (perHeadAmount) data.perHeadBudget = perHeadAmount;
  if (time) data.time = time;
  if (namedTheme) data.theme = namedTheme.replace(/^(?:is|:|=|to)\s*/i, '').slice(0, 120);
  if (venueTier) data.venueTier = venueTier;
  if (cateringNotes) data.cateringNotes = cateringNotes.slice(0, 240);
  return data;
}

function isPendingEventCreation(history) {
  const rows = Array.isArray(history) ? history : [];
  const initiated = rows.some(x => x.role === 'user' && isEventCreationIntent(String(x.content || '')));
  const lastAssistant = [...rows].reverse().find(x => x.role === 'assistant')?.content || '';
  return initiated && /(?:please share|what date|which date|guest count|approximate guest|what budget|location|provide the following)/i.test(lastAssistant);
}

function parseDirectPortalChange(value, workspace) {
  const message = String(value || '').trim();
  const lower = message.toLowerCase();
  let candidate = null;
  const requestedStatus = /\b(booked|book|confirm(?:ed)?|contacted|shortlist(?:ed)?|quote received|declined)\b/i.exec(message)?.[1]?.toLowerCase();
  if (requestedStatus && /\b(mark|set|update|change)\b/i.test(message)) {
    const status = requestedStatus.startsWith('book') || requestedStatus === 'confirm' || requestedStatus === 'confirmed' ? 'Booked' : requestedStatus === 'contacted' ? 'Contacted' : requestedStatus.startsWith('shortlist') ? 'Shortlisted' : requestedStatus === 'quote received' ? 'Quote received' : requestedStatus === 'declined' ? 'Declined' : null;
    const vendors = workspace.vendors.filter(v => lower.includes(String(v.name).toLowerCase()));
    if (status && vendors.length === 1) candidate = { entity: 'vendor', action: 'update', target: vendors[0].name, data: { status } };
  }
  if (!candidate && /\b(rsvp|attending|coming|aane|aa raha|aa rahi)\b/i.test(message) && /\b(mark|set|update|change|record)\b|\b(karo|kar do)\b/i.test(message)) {
    const guests = workspace.guests.filter(g => lower.includes(String(g.name).toLowerCase()));
    const rsvp = /\b(yes|haan|attending|coming|confirm)\b/i.test(message) ? 'Yes' : /\b(no|nahi|not coming|declined)\b/i.test(message) ? 'No' : /\b(pending|not sure|undecided)\b/i.test(message) ? 'Pending' : null;
    if (rsvp && guests.length === 1) candidate = { entity: 'guest', action: 'update', target: guests[0].name, data: { rsvp } };
  }
  if (!candidate && /\b(theme)\b/i.test(message) && /\b(change|update|set)\b/i.test(message)) {
    const match = /\btheme\s+(?:to|as|=)\s+(.+?)(?:[.!?]|$)/i.exec(message);
    if (match) candidate = { entity: 'event', action: 'update', data: { theme: match[1].trim() } };
  }
  if (!candidate && /\b(add|create)\b/i.test(message) && /\btask\b/i.test(message)) {
    const title = /\b(?:called|named|titled)\s+["“]?(.+?)["”]?(?=\s*(?:,|;)?\s*(?:due|by|category|priority)\b|[.!?]|$)/i.exec(message)?.[1]?.trim();
    const due = findEventDate(message);
    if (title && due) {
      const priority = /\bhigh\s+priority\b/i.test(message) ? 'High' : /\blow\s+priority\b/i.test(message) ? 'Low' : 'Medium';
      candidate = { entity: 'task', action: 'create', data: { title, due, priority, category: 'Planning' } };
    }
  }
  if (!candidate && /\b(add|create)\b/i.test(message) && /\b(vendor|caterer|photographer|decorator|florist|dj)\b/i.test(message)) {
    const name = /\b(?:vendor|caterer|photographer|decorator|florist|dj)\s+(?:called|named)\s+(.+?)(?=\s+(?:for|with|quote|quoted|location|in)\b|[.!?]|$)/i.exec(message)?.[1]?.trim();
    const category = /\bcaterer\b|\bcatering\b/i.test(message) ? 'Catering' : /\bphotographer\b/i.test(message) ? 'Photographer' : /\bdecorator\b/i.test(message) ? 'Decorator' : /\bflorist\b/i.test(message) ? 'Florist' : /\bdj\b/i.test(message) ? 'DJ' : 'Other';
    const quoteMatch = /\b(?:quote(?:d)?|price|for)\s+(?:₹|rs\.?|inr|\$|€|£)?\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k|thousand|lakh|lakhs|lac|lacs|million|m)?/i.exec(message);
    const locationMatch = /\b(?:location|in)\s+(?:is\s+)?([^,.;!?]+)/i.exec(message);
    if (name) {
      const raw = quoteMatch ? Number(quoteMatch[1].replace(/,/g, '')) : 0;
      const unit = (quoteMatch?.[2] || '').toLowerCase();
      const quote = Math.round(raw * (['k', 'thousand'].includes(unit) ? 1000 : ['lakh', 'lakhs', 'lac', 'lacs'].includes(unit) ? 100000 : ['million', 'm'].includes(unit) ? 1000000 : 1));
      candidate = { entity: 'vendor', action: 'create', data: { name, category, quote, location: locationMatch?.[1]?.trim() || '' } };
    }
  }
  if (!candidate && /\b(add|create)\b/i.test(message) && /\bguest\b/i.test(message)) {
    const name = /\bguest\s+(?:called|named)\s+(.+?)(?=\s+(?:contact|phone|email|rsvp|dietary|category)\b|[.!?]|$)/i.exec(message)?.[1]?.trim();
    if (name) {
      const rsvp = /\b(yes|attending|confirmed)\b/i.test(message) ? 'Yes' : /\b(no|declined)\b/i.test(message) ? 'No' : 'Pending';
      const dietary = /\b(vegan|vegetarian|jain|gluten[- ]free|halal|kosher)\b/i.exec(message)?.[1] || 'None';
      const contact = /\b(?:contact|phone|email)\s+(?:is\s+)?([^,.;!?\s]+)/i.exec(message)?.[1] || '';
      candidate = { entity: 'guest', action: 'create', data: { name, rsvp, dietary, contact } };
    }
  }
  if (!candidate && /\b(add|create)\b/i.test(message) && /\bexpense\b/i.test(message)) {
    const name = /\bexpense\s+(?:called|named|for)\s+(.+?)(?=\s+(?:for|at)\s+(?:₹|rs\.?|inr|\$|€|£)?\s*\d|[.!?]|$)/i.exec(message)?.[1]?.trim();
    const amountMatch = /\b(?:for|at)\s+(?:₹|rs\.?|inr|\$|€|£)?\s*([\d][\d,]*(?:\.\d{1,2})?)\s*(k|thousand|lakh|lakhs|lac|lacs|million|m)?/i.exec(message);
    if (name && amountMatch) {
      const raw = Number(amountMatch[1].replace(/,/g, ''));
      const unit = (amountMatch[2] || '').toLowerCase();
      const planned = Math.round(raw * (['k', 'thousand'].includes(unit) ? 1000 : ['lakh', 'lakhs', 'lac', 'lacs'].includes(unit) ? 100000 : ['million', 'm'].includes(unit) ? 1000000 : 1));
      candidate = { entity: 'expense', action: 'create', data: { name, category: 'Miscellaneous', planned } };
    }
  }
  if (!candidate && /\b(remove|delete)\b/i.test(message)) {
    const collections = [
      ['task', workspace.tasks, 'title'], ['expense', workspace.expenses, 'name'], ['vendor', workspace.vendors, 'name'], ['guest', workspace.guests, 'name']
    ];
    const matches = collections.flatMap(([entity, rows, key]) => rows.filter(row => lower.includes(String(row[key]).toLowerCase())).map(row => ({ entity, target: row[key] })));
    if (matches.length === 1) candidate = { entity: matches[0].entity, action: 'delete', target: matches[0].target, data: {} };
  }
  return candidate ? buildPortalChange(candidate, workspace) : null;
}

module.exports = { buildPortalChange, applyPortalChange, clarifyPortalChange, isEventCreationIntent, isPendingEventCreation, extractEventCreationData, parseDirectPortalChange, shouldEnablePortalTool, eventTypeFromText, findEventTime };

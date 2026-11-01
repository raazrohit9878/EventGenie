module.exports = function starterWorkspace() {
  return {
    event: { name: 'An evening to remember', type: 'Wedding', date: '2026-12-12', time: '', location: 'Jaipur, Rajasthan', guests: 120, budget: 1200000, currency: '₹', theme: 'Garden romance', venue: 'Outdoor garden', venueTier: '', dietary: 'Vegetarian options', cateringNotes: '', priorities: 'Beautiful photography, guest comfort' },
    expenses: [
      { id: 1, name: 'Garden venue', category: 'Venue', planned: 300000, actual: 0 }, { id: 2, name: 'Catering', category: 'Catering', planned: 300000, actual: 0 },
      { id: 3, name: 'Florals & decor', category: 'Decoration', planned: 180000, actual: 0 }, { id: 4, name: 'Photography', category: 'Photography', planned: 120000, actual: 0 },
      { id: 5, name: 'Music & entertainment', category: 'Entertainment', planned: 90000, actual: 0 }, { id: 6, name: 'Invitations', category: 'Invitations', planned: 45000, actual: 0 },
      { id: 7, name: 'Attire & beauty', category: 'Clothing', planned: 90000, actual: 0 }, { id: 8, name: 'Contingency', category: 'Miscellaneous', planned: 75000, actual: 0 }
    ],
    tasks: [
      { id: 1, title: 'Shortlist and visit venues', category: 'Venue', due: '2026-11-05', priority: 'High', status: 'Completed' },
      { id: 2, title: 'Confirm guest list and save the dates', category: 'Guests', due: '2026-11-10', priority: 'High', status: 'In progress' },
      { id: 3, title: 'Book photographer', category: 'Vendor', due: '2026-11-14', priority: 'High', status: 'Not started' },
      { id: 4, title: 'Choose menu and arrange tasting', category: 'Catering', due: '2026-11-20', priority: 'Medium', status: 'Not started' },
      { id: 5, title: 'Finalize flowers and table styling', category: 'Decoration', due: '2026-11-26', priority: 'Medium', status: 'Not started' },
      { id: 6, title: 'Send formal invitations', category: 'Guests', due: '2026-11-28', priority: 'High', status: 'Not started' }
    ],
    vendors: [
      { id: 1, name: 'The Marigold House', category: 'Venue', contact: 'hello@marigold.example', location: 'Jaipur', quote: 300000, status: 'Shortlisted', notes: 'Garden venue; capacity to confirm' },
      { id: 2, name: 'Saffron Table Co.', category: 'Catering', contact: '+91 98765 43210', location: 'Jaipur', quote: 240000, status: 'Contacted', notes: 'Vegetarian menu options' },
      { id: 3, name: 'Golden Hour Studio', category: 'Photography', contact: 'studio@example.test', location: 'Jaipur', quote: 120000, status: 'Shortlisted', notes: 'Portfolio link pending' }
    ],
    guests: [
      { id: 1, name: 'Aarav Mehta', contact: 'aarav@example.test', category: 'Family', rsvp: 'Yes', dietary: 'Vegetarian' },
      { id: 2, name: 'Mira Kapoor', contact: 'mira@example.test', category: 'Friends', rsvp: 'Pending', dietary: 'None' },
      { id: 3, name: 'Kabir Shah', contact: 'kabir@example.test', category: 'Family', rsvp: 'Yes', dietary: 'Jain' }
    ],
    ideasSaved: [],
    chat: [{ who: 'ai', text: 'Hello! I’m Genie, your event planning companion. I can help you think through your saved event, budget, and next steps. What would you like to work on?' }]
  };
};

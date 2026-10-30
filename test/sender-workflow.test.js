import {it,expect} from 'vitest';
import {senderProvider,senderMatches,manualDraft} from '../public/sender-workflow.js';
it('suggests known consumer providers but does not guess business hosting',()=>{
  expect(senderProvider('PERSON@GMAIL.COM')).toBe('gmail');
  expect(senderProvider('a@outlook.com')).toBe('outlook');
  expect(senderProvider('a@business.example')).toBe('choose');
  expect(senderProvider('a@gmail.com.attacker.example')).toBe('choose');
  expect(senderMatches('Person@Example.com ','person@example.com')).toBe(true);
  expect(senderMatches('a@example.com','b@example.com')).toBe(false);
});
it('creates an unsent interoperable draft without injecting headers',()=>{
  const draft=manualDraft({from:'a@example.com',to:'abuse@example.org',subject:'Removal — request',body:'Please review this URL.\nThank you.'});
  expect(draft.eml).toContain('X-Unsent: 1\r\n');expect(draft.eml).toContain('From: a@example.com');
  expect(draft.mailto).not.toContain('from=');
  expect(()=>manualDraft({from:'a@example.com\r\nBcc:other@example.com',to:'abuse@example.org',subject:'Test',body:'Text'})).toThrow();
});

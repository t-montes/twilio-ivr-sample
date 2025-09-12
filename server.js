const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json()); // also accept JSON

// Dummy DB - now as array with last 4 SSN digits
const dummyDB = [
  { last4ssn: "6789", dob: "01011990", zip: "90210", name: "Tony" },
  { last4ssn: "4321", dob: "12051985", zip: "10001", name: "Alice" }
];

// State store: CallSid → { last4ssn, dob, zip, attempts }
const state = {};

function getState(callSid) {
  if (!state[callSid]) {
    state[callSid] = { attempts: { last4ssn: 0, dob: 0, zip: 0 } };
  }
  return state[callSid];
}

function tooManyAttempts(vr, step, callSid, res) {
  const s = getState(callSid);
  if (s.attempts[step] >= 4) {
    vr.say("Too many invalid attempts. Goodbye.");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
    return true;
  }
  return false;
}

function isValidDOB(dob) {
  if (!/^\d{8}$/.test(dob)) return false;
  const month = parseInt(dob.slice(0,2));
  const day   = parseInt(dob.slice(2,4));
  const year  = parseInt(dob.slice(4,8));

  if (month < 1 || month > 12) return false;
  if (year < 1900) return false;

  const date = new Date(year, month - 1, day);
  const now = new Date();
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return false;
  if (date > now) return false;
  return true;
}

// 1) Start: ask last 4 SSN digits
app.post('/start', (req, res) => {
  console.log("🎯 Starting SSN validation flow for CallSid:", req.body.CallSid);
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'dtmf', // DTMF only
    numDigits: 4,
    action: '/validate-ssn',
    method: 'POST'
  });
  g.say('Please enter the last four digits of your social security number using your phone keypad.');
  vr.say('Sorry, I did not get that.');
  vr.redirect('/start');
  res.type('text/xml').send(vr.toString());
});

// 2) Validate last 4 SSN digits
app.post('/validate-ssn', (req, res) => {
  const callSid = req.body.CallSid;
  const last4ssn = (req.body.Digits || '').replace(/\D/g, '');
  console.log("🔍 Validating last 4 SSN digits for CallSid:", callSid, "Value:", last4ssn);
  const vr = new VoiceResponse();
  const s = getState(callSid);

  if (!last4ssn || last4ssn.length !== 4) {
    s.attempts.last4ssn++;
    console.log("❌ Invalid or empty last 4 SSN attempt:", s.attempts.last4ssn);
    if (tooManyAttempts(vr, "last4ssn", callSid, res)) return;
    vr.say("That was not four digits. Please try again using your keypad.");
    vr.redirect('/start');
    return res.type('text/xml').send(vr.toString());
  }

  s.last4ssn = last4ssn;
  console.log("✅ Last 4 SSN digits validated and stored for CallSid:", callSid);
  vr.say("Thank you. Now, please enter your date of birth using your keypad.");
  vr.redirect('/ask-dob');
  res.type('text/xml').send(vr.toString());
});

// 3) Ask DOB
app.post('/ask-dob', (req, res) => {
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'dtmf',
    numDigits: 8,
    action: '/validate-dob',
    method: 'POST'
  });
  g.say('Enter your date of birth as month month day day year year year year using your phone keypad.');
  vr.say('Sorry, I did not get that.');
  vr.redirect('/ask-dob');
  res.type('text/xml').send(vr.toString());
});

// 4) Validate DOB
app.post('/validate-dob', (req, res) => {
  const callSid = req.body.CallSid;
  const dob = (req.body.Digits || '').replace(/\D/g, '');
  console.log("📅 Validating DOB for CallSid:", callSid, "Value:", dob);
  const vr = new VoiceResponse();
  const s = getState(callSid);

  if (!dob || !isValidDOB(dob)) {
    s.attempts.dob++;
    console.log("❌ Invalid or empty DOB attempt:", s.attempts.dob);
    if (tooManyAttempts(vr, "dob", callSid, res)) return;
    vr.say("That date of birth was not valid. Please try again using your keypad.");
    vr.redirect('/ask-dob');
    return res.type('text/xml').send(vr.toString());
  }

  s.dob = dob;
  console.log("✅ DOB validated and stored for CallSid:", callSid);
  vr.say("Got it. Now enter your five digit zip code using your keypad.");
  vr.redirect('/ask-zip');
  res.type('text/xml').send(vr.toString());
});

// 5) Ask ZIP
app.post('/ask-zip', (req, res) => {
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'dtmf',
    numDigits: 5,
    action: '/final-validate',
    method: 'POST'
  });
  g.say('Enter your five digit zip code using your phone keypad.');
  vr.say('Sorry, I did not get that.');
  vr.redirect('/ask-zip');
  res.type('text/xml').send(vr.toString());
});

// 6) Final validate
app.post('/final-validate', async (req, res) => {
  const callSid = req.body.CallSid;
  const zip = (req.body.Digits || '').replace(/\D/g, '');
  const vr = new VoiceResponse();
  const s = getState(callSid);

  if (!zip || zip.length !== 5) {
    s.attempts.zip++;
    console.log("❌ Invalid or empty ZIP attempt:", s.attempts.zip);
    if (tooManyAttempts(vr, "zip", callSid, res)) return;
    vr.say("That zip code did not look right. Please try again using your keypad.");
    vr.redirect('/ask-zip');
    return res.type('text/xml').send(vr.toString());
  }

  s.zip = zip;
  console.log("📋 Complete user data:", s);

  try {
    const { data } = await axios.post("http://localhost:3000/check-user", s);
    if (data.ok) {
      vr.say(`Welcome ${data.name}, you are verified.`);
      const dial = vr.dial();
      dial.number('+12345678910'); // dummy target
    } else {
      vr.say("Those details did not match our records. Restarting the process.");
      vr.redirect('/start');
    }
  } catch (err) {
    console.error("❌ Error calling /check-user:", err.message);
    vr.say("An error occurred. Please try again later.");
    vr.hangup();
  }

  res.type('text/xml').send(vr.toString());
});

// 7) Internal DB check
app.post('/check-user', (req, res) => {
  const { last4ssn, dob, zip } = req.body;
  console.log("📥 check-user got body:", req.body);

  // Search through array to find record where all 3 items match
  const record = dummyDB.find(r => r.last4ssn === last4ssn && r.dob === dob && r.zip === zip);
  if (record) {
    return res.json({ ok: true, name: record.name });
  }
  return res.json({ ok: false });
});

app.listen(3000, () => console.log('🚀 Server running on port 3000'));

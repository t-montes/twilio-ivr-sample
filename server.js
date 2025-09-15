/**
 * Complete Twilio IVR Flow Implementation
 * 0. Mini-miranda
 * 1. English-spanish language selection
 * 2. Let user know that there are no CSR agents at the time, or that there are
 * 3. Ask for the question they want to handle
 * 4. LLM classify whether the question is account-specific or not
 *   - If it's account-specific ask for the dob, last 4 ssn digits, and zip code, and afterwards, if user's found, save the phone_number to the db.json and transfer call to +19343453827 FROM the customer's phone number
 *   - If it's not account-specific, transfer call to +19343453827 FROM the assistant's, current Twilio's, phone number (+12295446861)
 */

const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Configuration
const CONFIG = {
  TARGET_PHONE: '+19343453827',
  TWILIO_PHONE: '+12295446861',
  MAX_ATTEMPTS: 4,
  OPENAI_API_URL: 'https://api.openai.com/v1/chat/completions',
  DB_FILE: './db.json'
};

// Load database
let dummyDB = require('./db.json');

// Enhanced state store with complete flow tracking
const state = {};

function getState(callSid) {
  if (!state[callSid]) {
    state[callSid] = {
      currentStep: 'mini-miranda',
      language: null, // 'en' or 'es'
      question: null,
      questionType: null, // 'account-specific' or 'general'
      last4ssn: null,
      dob: null,
      zip: null,
      phoneNumber: null,
      attempts: {
        language: 0,
        question: 0,
        last4ssn: 0,
        dob: 0,
        zip: 0
      }
    };
  }
  return state[callSid];
}

// Utility functions
function tooManyAttempts(vr, step, callSid, res) {
  const s = getState(callSid);
  if (s.attempts[step] >= CONFIG.MAX_ATTEMPTS) {
    const lang = s.language || 'en';
    vr.say(MESSAGES[lang].tooManyAttempts);
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

// Multi-language messages
const MESSAGES = {
  en: {
    miniMiranda: "This call may be monitored or recorded for quality and training purposes.",
    languagePrompt: "For English, press 1. Para Español, presiona 2.",
    noCSRAgents: "Please note that there are currently no customer service representatives available.",
    questionPrompt: "Please briefly describe what you need help with after the beep, then press pound.",
    invalidLanguage: "Invalid selection. Please try again.",
    ssn4Prompt: "Please enter the last four digits of your social security number using your phone keypad.",
    dobPrompt: "Enter your date of birth as month month day day year year year year using your phone keypad.",
    zipPrompt: "Enter your five digit zip code using your phone keypad.",
    invalidSSN: "That was not four digits. Please try again using your keypad.",
    invalidDOB: "That date of birth was not valid. Please try again using your keypad.",
    invalidZIP: "That zip code did not look right. Please try again using your keypad.",
    verificationSuccess: "Welcome {name}, you are verified. Transferring you now.",
    verificationFailed: "Those details did not match our records. Please try again.",
    transferring: "Please hold while we transfer your call.",
    tooManyAttempts: "Too many invalid attempts. Goodbye.",
    systemError: "An error occurred. Please try again later.",
    noInput: "Sorry, I did not get that."
  },
  es: {
    miniMiranda: "Esta llamada puede ser monitoreada o grabada para propósitos de calidad y entrenamiento.",
    languagePrompt: "For English, press 1. Para Español, presiona 2.",
    noCSRAgents: "Por favor tenga en cuenta que actualmente no hay representantes de servicio al cliente disponibles.",
    questionPrompt: "Por favor describa brevemente en qué necesita ayuda después del tono, luego presiona numeral.",
    invalidLanguage: "Selección inválida. Por favor intente de nuevo.",
    ssn4Prompt: "Por favor ingrese los últimos cuatro dígitos de su número de seguro social usando el teclado de su teléfono.",
    dobPrompt: "Ingrese su fecha de nacimiento como mes mes día día año año año año usando el teclado de su teléfono.",
    zipPrompt: "Ingrese su código postal de cinco dígitos usando el teclado de su teléfono.",
    invalidSSN: "Eso no fueron cuatro dígitos. Por favor intente de nuevo usando su teclado.",
    invalidDOB: "Esa fecha de nacimiento no fue válida. Por favor intente de nuevo usando su teclado.",
    invalidZIP: "Ese código postal no se ve correcto. Por favor intente de nuevo usando su teclado.",
    verificationSuccess: "Bienvenido {name}, está verificado. Transfiriéndolo ahora.",
    verificationFailed: "Esos detalles no coincidieron con nuestros registros. Por favor intente de nuevo.",
    transferring: "Por favor manténgase en línea mientras transferimos su llamada.",
    tooManyAttempts: "Demasiados intentos inválidos. Adiós.",
    systemError: "Ocurrió un error. Por favor intente de nuevo más tarde.",
    noInput: "Lo siento, no recibí eso."
  }
};

// Action-based routing system
const ACTIONS = {
  'mini-miranda': handleMiniMiranda,
  'language-selection': handleLanguageSelection,
  'process-language': processLanguageSelection,
  'csr-notice': handleCSRNotice,
  'ask-question': handleQuestionPrompt,
  'process-question': processQuestion,
  'classify-question': classifyQuestion,
  'ask-ssn': handleSSNPrompt,
  'process-ssn': processSSN,
  'ask-dob': handleDOBPrompt,
  'process-dob': processDOB,
  'ask-zip': handleZIPPrompt,
  'process-zip': processZIP,
  'verify-user': verifyUser,
  'transfer-call': transferCall
};

async function savePhoneNumberToDB(phoneNumber, userRecord) {
  try {
    // Add phone number to the user record
    const updatedRecord = { ...userRecord, phoneNumber };
    
    // Find and update the record in the array
    const recordIndex = dummyDB.findIndex(r => 
      r.last4ssn === userRecord.last4ssn && 
      r.dob === userRecord.dob && 
      r.zip === userRecord.zip
    );
    
    if (recordIndex !== -1) {
      dummyDB[recordIndex] = updatedRecord;
      // Save to file
      await fs.writeFile(CONFIG.DB_FILE, JSON.stringify(dummyDB, null, 4));
      console.log("📱 Phone number saved to database:", phoneNumber);
    }
  } catch (error) {
    console.error("❌ Error saving phone number to database:", error);
  }
}

// LLM Classification function
async function classifyQuestionWithLLM(question) {
  // For demo purposes, using rule-based classification
  // In production, you would call OpenAI API here
  
  const accountSpecificKeywords = [
    'account', 'balance', 'payment', 'bill', 'statement', 'charge',
    'transaction', 'refund', 'dispute', 'my', 'personal', 'private'
  ];
  
  const questionLower = question.toLowerCase();
  const isAccountSpecific = accountSpecificKeywords.some(keyword => 
    questionLower.includes(keyword)
  );
  
  return isAccountSpecific ? 'account-specific' : 'general';
  
  /* Uncomment for actual OpenAI integration:
  try {
    const response = await axios.post(CONFIG.OPENAI_API_URL, {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a customer service classifier. Respond with ONLY 'account-specific' or 'general'. Account-specific questions require personal information to answer (like account balances, personal details, billing issues). General questions can be answered without accessing customer records (like hours of operation, general policies, how-to questions)."
        },
        {
          role: "user",
          content: `Classify this customer question: "${question}"`
        }
      ],
      max_tokens: 10,
      temperature: 0
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    const classification = response.data.choices[0].message.content.trim().toLowerCase();
    return classification.includes('account-specific') ? 'account-specific' : 'general';
  } catch (error) {
    console.error("❌ Error classifying question:", error);
    // Fallback to rule-based classification
    return isAccountSpecific ? 'account-specific' : 'general';
  }
  */
}

// ===== ACTION HANDLERS =====

// 0. Mini-miranda handler
function handleMiniMiranda(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  console.log("📢 Mini-miranda for CallSid:", callSid);
  
  const vr = new VoiceResponse();
  vr.say(MESSAGES.en.miniMiranda); // Always start in English
  s.currentStep = 'language-selection';
  vr.redirect('/action');
  res.type('text/xml').send(vr.toString());
}

// 1. Language selection handler
function handleLanguageSelection(req, res) {
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'dtmf',
    numDigits: 1,
    action: '/action?step=process-language',
    method: 'POST'
  });
  g.say(MESSAGES.en.languagePrompt);
  vr.say(MESSAGES.en.noInput);
  vr.redirect('/action?step=language-selection');
  res.type('text/xml').send(vr.toString());
}

function processLanguageSelection(req, res) {
  const callSid = req.body.CallSid;
  const digit = req.body.Digits;
  const s = getState(callSid);
  console.log("🌐 Language selection for CallSid:", callSid, "Digit:", digit);
  
  const vr = new VoiceResponse();
  
  if (digit === '1') {
    s.language = 'en';
    s.currentStep = 'csr-notice';
    vr.redirect('/action');
  } else if (digit === '2') {
    s.language = 'es';
    s.currentStep = 'csr-notice';
    vr.redirect('/action');
  } else {
    s.attempts.language++;
    if (tooManyAttempts(vr, 'language', callSid, res)) return;
    vr.say(MESSAGES.en.invalidLanguage);
    vr.redirect('/action?step=language-selection');
  }
  
  res.type('text/xml').send(vr.toString());
}

// 2. CSR notice handler
function handleCSRNotice(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("👥 CSR notice for CallSid:", callSid, "Language:", lang);
  
  const vr = new VoiceResponse();
  vr.say(MESSAGES[lang].noCSRAgents);
  s.currentStep = 'ask-question';
  vr.redirect('/action');
  res.type('text/xml').send(vr.toString());
}

// 3. Question prompt handler
function handleQuestionPrompt(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'speech',
    speechTimeout: 'auto',
    action: '/action?step=process-question',
    method: 'POST'
  });
  g.say(MESSAGES[lang].questionPrompt);
  vr.say(MESSAGES[lang].noInput);
  vr.redirect('/action?step=ask-question');
  res.type('text/xml').send(vr.toString());
}

function processQuestion(req, res) {
  const callSid = req.body.CallSid;
  const question = req.body.SpeechResult || '';
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("❓ Question received for CallSid:", callSid, "Question:", question);
  
  if (!question.trim()) {
    s.attempts.question++;
    const vr = new VoiceResponse();
    if (tooManyAttempts(vr, 'question', callSid, res)) return;
    vr.say(MESSAGES[lang].noInput);
    vr.redirect('/action?step=ask-question');
    return res.type('text/xml').send(vr.toString());
  }
  
  s.question = question;
  s.currentStep = 'classify-question';
  const vr = new VoiceResponse();
  vr.redirect('/action');
  res.type('text/xml').send(vr.toString());
}

// 4. Question classification
async function classifyQuestion(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  console.log("🤖 Classifying question for CallSid:", callSid);
  
  try {
    s.questionType = await classifyQuestionWithLLM(s.question);
    console.log("📊 Question classified as:", s.questionType);
    
    const vr = new VoiceResponse();
    if (s.questionType === 'account-specific') {
      s.currentStep = 'ask-ssn';
      // Store phone number for later saving to DB
      s.phoneNumber = req.body.From;
    } else {
      s.currentStep = 'transfer-call';
    }
    vr.redirect('/action');
    res.type('text/xml').send(vr.toString());
  } catch (error) {
    console.error("❌ Error classifying question:", error);
    const vr = new VoiceResponse();
    vr.say(MESSAGES[s.language || 'en'].systemError);
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  }
}

// SSN, DOB, ZIP handlers (account-specific path)
function handleSSNPrompt(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'dtmf',
    numDigits: 4,
    action: '/action?step=process-ssn',
    method: 'POST'
  });
  g.say(MESSAGES[lang].ssn4Prompt);
  vr.say(MESSAGES[lang].noInput);
  vr.redirect('/action?step=ask-ssn');
  res.type('text/xml').send(vr.toString());
}

function processSSN(req, res) {
  const callSid = req.body.CallSid;
  const last4ssn = (req.body.Digits || '').replace(/\D/g, '');
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("🔢 Processing SSN for CallSid:", callSid, "Value:", last4ssn);
  
  const vr = new VoiceResponse();
  
  if (!last4ssn || last4ssn.length !== 4) {
    s.attempts.last4ssn++;
    if (tooManyAttempts(vr, 'last4ssn', callSid, res)) return;
    vr.say(MESSAGES[lang].invalidSSN);
    vr.redirect('/action?step=ask-ssn');
    return res.type('text/xml').send(vr.toString());
  }
  
  s.last4ssn = last4ssn;
  s.currentStep = 'ask-dob';
  vr.redirect('/action');
  res.type('text/xml').send(vr.toString());
}

function handleDOBPrompt(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'dtmf',
    numDigits: 8,
    action: '/action?step=process-dob',
    method: 'POST'
  });
  g.say(MESSAGES[lang].dobPrompt);
  vr.say(MESSAGES[lang].noInput);
  vr.redirect('/action?step=ask-dob');
  res.type('text/xml').send(vr.toString());
}

function processDOB(req, res) {
  const callSid = req.body.CallSid;
  const dob = (req.body.Digits || '').replace(/\D/g, '');
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("📅 Processing DOB for CallSid:", callSid, "Value:", dob);
  
  const vr = new VoiceResponse();
  
  if (!dob || !isValidDOB(dob)) {
    s.attempts.dob++;
    if (tooManyAttempts(vr, 'dob', callSid, res)) return;
    vr.say(MESSAGES[lang].invalidDOB);
    vr.redirect('/action?step=ask-dob');
    return res.type('text/xml').send(vr.toString());
  }
  
  s.dob = dob;
  s.currentStep = 'ask-zip';
  vr.redirect('/action');
  res.type('text/xml').send(vr.toString());
}

function handleZIPPrompt(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'dtmf',
    numDigits: 5,
    action: '/action?step=process-zip',
    method: 'POST'
  });
  g.say(MESSAGES[lang].zipPrompt);
  vr.say(MESSAGES[lang].noInput);
  vr.redirect('/action?step=ask-zip');
  res.type('text/xml').send(vr.toString());
}

function processZIP(req, res) {
  const callSid = req.body.CallSid;
  const zip = (req.body.Digits || '').replace(/\D/g, '');
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("📮 Processing ZIP for CallSid:", callSid, "Value:", zip);
  
  const vr = new VoiceResponse();
  
  if (!zip || zip.length !== 5) {
    s.attempts.zip++;
    if (tooManyAttempts(vr, 'zip', callSid, res)) return;
    vr.say(MESSAGES[lang].invalidZIP);
    vr.redirect('/action?step=ask-zip');
    return res.type('text/xml').send(vr.toString());
  }
  
  s.zip = zip;
  s.currentStep = 'verify-user';
  vr.redirect('/action');
  res.type('text/xml').send(vr.toString());
}

// User verification and transfer
async function verifyUser(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("🔍 Verifying user for CallSid:", callSid);
  
  const vr = new VoiceResponse();
  
  try {
    const record = dummyDB.find(r => 
      r.last4ssn === s.last4ssn && 
      r.dob === s.dob && 
      r.zip === s.zip
    );
    
    if (record) {
      console.log("✅ User verified:", record.name);
      // Save phone number to database
      await savePhoneNumberToDB(s.phoneNumber, record);
      
      vr.say(MESSAGES[lang].verificationSuccess.replace('{name}', record.name));
      s.currentStep = 'transfer-call';
      vr.redirect('/action');
    } else {
      console.log("❌ User verification failed");
      vr.say(MESSAGES[lang].verificationFailed);
      // Reset for another attempt
      s.currentStep = 'ask-ssn';
      s.attempts.last4ssn = 0;
      s.attempts.dob = 0;
      s.attempts.zip = 0;
      vr.redirect('/action');
    }
  } catch (error) {
    console.error("❌ Error verifying user:", error);
    vr.say(MESSAGES[lang].systemError);
    vr.hangup();
  }
  
  res.type('text/xml').send(vr.toString());
}

// Transfer call based on question type
function transferCall(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("📞 Transferring call for CallSid:", callSid, "Type:", s.questionType);
  
  const vr = new VoiceResponse();
  vr.say(MESSAGES[lang].transferring);
  
  const dial = vr.dial();
  if (s.questionType === 'account-specific' && s.phoneNumber) {
    // Transfer FROM customer's phone number for account-specific questions
    dial.number(CONFIG.TARGET_PHONE, { callerId: s.phoneNumber });
    console.log("📱 Transferring account-specific call FROM:", s.phoneNumber);
  } else {
    // Transfer FROM Twilio's phone number for general questions
    dial.number(CONFIG.TARGET_PHONE, { callerId: CONFIG.TWILIO_PHONE });
    console.log("📱 Transferring general call FROM:", CONFIG.TWILIO_PHONE);
  }
  
  res.type('text/xml').send(vr.toString());
}

// ===== ROUTING =====

// Main entry point - starts the flow
app.post('/start', (req, res) => {
  const callSid = req.body.CallSid;
  console.log("🎯 Starting complete IVR flow for CallSid:", callSid);
  
  // Store the caller's phone number
  const s = getState(callSid);
  s.phoneNumber = req.body.From;
  s.currentStep = 'mini-miranda';
  
  const vr = new VoiceResponse();
  vr.redirect('/action');
  res.type('text/xml').send(vr.toString());
});

// Action router - handles all steps through the actions system
app.post('/action', async (req, res) => {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const step = req.query.step || s.currentStep;
  
  console.log("🎬 Action router - CallSid:", callSid, "Step:", step);
  
  const actionHandler = ACTIONS[step];
  if (actionHandler) {
    await actionHandler(req, res);
  } else {
    console.error("❌ Unknown action:", step);
    const vr = new VoiceResponse();
    vr.say(MESSAGES[s.language || 'en'].systemError);
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  }
});

app.listen(3000, () => console.log('🚀 Server running on port 3000'));

/**
 * Complete Twilio IVR Flow Implementation
 * 0. English-spanish language selection (first step)
 * 1. Mini-miranda (in selected language)
 * 2. Time-based CSR availability check:
 *    - If before 8pm EST: Skip CSR notice, go directly to question
 *    - If after 8pm EST: Show "no agents available" message, then continue
 * 3. Ask user to choose question type via DTMF:
 *    - Press 1: General information (transfer with Twilio number)
 *    - Press 2: Account-specific/Payment questions (verify identity first)
 * 4. Route based on selection:
 *   - If account-specific: ask for dob, last 4 ssn digits, and zip code, verify user, save phone_number to db.json, then transfer call to +19343453827 FROM the customer's phone number
 *   - If general: transfer call to +19343453827 FROM the assistant's Twilio phone number (+12295446861)
 * 
 * VOICE CONFIGURATION:
 * - Uses Google TTS with different voices for English and Spanish
 * - English: Google.en-AU-Chirp3-HD-Aoede 
 * - Spanish: Google.es-ES-Chirp3-HD-Aoede
 * - Language selection plays English with English voice, Spanish with Spanish voice
 * - All subsequent prompts use the voice matching the selected language
 * - Voice configuration can be updated in CONFIG.VOICES section
 * 
 * CSR AVAILABILITY:
 * - Automatically checks current time in EST timezone
 * - CSR agents available: Before 8pm EST (skip notice entirely)
 * - CSR agents unavailable: After 8pm EST (show unavailability message)
 * - Configurable in CONFIG.CSR_HOURS section
 * - Test availability at GET /test-csr-availability endpoint
 * - Test flow behavior at GET /test-csr-flow endpoint
 * 
 * QUESTION TYPE CLASSIFICATION:
 * - Simple DTMF-based selection (no AI/LLM needed)
 * - Press 1: General information (direct transfer)
 * - Press 2: Account-specific/Payment (identity verification required)
 * - Test question type prompts at GET /test-question-flow endpoint
 * 
 * MAINTENANCE NOTES:
 * - Action-based architecture: all steps handled through ACTIONS mapping
 * - Multi-language support through MESSAGES object
 * - Voice routing through addSayWithVoice() utility function
 * - Easy to add new languages by updating CONFIG.VOICES and MESSAGES
 * - Time-based logic in areCSRAgentsAvailable() function
 * - Removed OpenAI/LLM dependency - using direct user selection instead
 */

const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const fs = require('fs').promises;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Configuration
const CONFIG = {
  TARGET_PHONE: '+19343453827',
  TWILIO_PHONE: '+12295446861',
  MAX_ATTEMPTS: 4,
  OPENAI_API_URL: 'https://api.openai.com/v1/chat/completions',
  DB_FILE: './db.json',
  // CSR availability hours (EST)
  CSR_HOURS: {
    CLOSING_HOUR: 20, // 8pm EST (24-hour format)
    TIMEZONE: 'America/New_York' // EST timezone
  },
  // Voice configuration based on Twilio documentation
  LANGUAGES: {
    en: 'en-US', // Google voice for English
    es: 'es-ES'  // Google voice for Spanish (US)
  },
  VOICES: {
    en: 'Google.en-AU-Chirp3-HD-Aoede',
    es: 'Google.es-ES-Chirp3-HD-Aoede'
  }
};

// Load database
let dummyDB = require('./db.json');

// Enhanced state store with complete flow tracking
const state = {};

function getState(callSid) {
  if (!state[callSid]) {
    state[callSid] = {
      currentStep: 'language-selection', // Start with language selection
      language: null, // 'en' or 'es'
      questionType: null, // 'account-specific' or 'general'
      last4ssn: null,
      dob: null,
      zip: null,
      phoneNumber: null,
      attempts: {
        language: 0,
        questionType: 0,
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
    addSayWithVoice(vr, MESSAGES[lang].tooManyAttempts, lang);
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
    languagePromptEn: "For English, press 1.",
    languagePromptEs: "Para Español, presiona 2.",
    noCSRAgents: "Please note that there are currently no customer service representatives available.",
    questionTypePrompt: "For general information, press 1. For account specific questions or to make a payment, press 2.",
    invalidQuestionType: "Invalid selection. Please try again.",
    invalidLanguage: "Invalid selection. Please try again.",
    ssn4Prompt: "Please enter the last four digits of your social security number using your phone keypad.",
    dobPrompt: "Enter your date of birth as month, month, day, day, year, year, year, year using your phone keypad.",
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
    languagePromptEn: "For English, press 1.",
    languagePromptEs: "Para Español, presiona 2.",
    noCSRAgents: "Por favor tenga en cuenta que actualmente no hay representantes de servicio al cliente disponibles.",
    questionTypePrompt: "Para información general, presiona 1. Para preguntas específicas de su cuenta o hacer un pago, presiona 2.",
    invalidQuestionType: "Selección inválida. Por favor intente de nuevo.",
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

// Utility functions for voice-specific TwiML
function addSayWithVoice(parent, text, simpleLanguage) {
  const language = CONFIG.LANGUAGES[simpleLanguage];
  const voice = CONFIG.VOICES[simpleLanguage];
  const say = parent.say({ language, voice }, text);
  return say;
}

function createVoiceResponse() {
  return new VoiceResponse();
}

// Check if CSR agents are available based on current time in EST
function areCSRAgentsAvailable() {
  const now = new Date();
  const estTime = new Date(now.toLocaleString("en-US", { timeZone: CONFIG.CSR_HOURS.TIMEZONE }));
  const currentHour = estTime.getHours();
  
  const isAvailable = currentHour < CONFIG.CSR_HOURS.CLOSING_HOUR;
  
  console.log(`🕐 Current EST time: ${estTime.toLocaleString()}, Hour: ${currentHour}, CSR Available: ${isAvailable}`);
  
  return isAvailable;
}

// Action-based routing system
const ACTIONS = {
  'mini-miranda': handleMiniMiranda,
  'language-selection': handleLanguageSelection,
  'process-language': processLanguageSelection,
  'csr-notice': handleCSRNotice,
  'ask-question-type': handleQuestionTypePrompt,
  'process-question-type': processQuestionType,
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
    console.log("💾 Attempting to save phone number:", phoneNumber);
    console.log("👤 For user record:", JSON.stringify(userRecord, null, 2));
    
    if (!phoneNumber) {
      console.error("❌ Phone number is null or undefined!");
      return;
    }
    
    // Add phone number to the user record
    const updatedRecord = { ...userRecord, phoneNumber };
    
    // Find and update the record in the array
    const recordIndex = dummyDB.findIndex(r => 
      r.last4ssn === userRecord.last4ssn && 
      r.dob === userRecord.dob && 
      r.zip === userRecord.zip
    );
    
    console.log("🔍 Found record at index:", recordIndex);
    
    if (recordIndex !== -1) {
      console.log("📝 Updating record:", JSON.stringify(updatedRecord, null, 2));
      dummyDB[recordIndex] = updatedRecord;
      // Save to file
      await fs.writeFile(CONFIG.DB_FILE, JSON.stringify(dummyDB, null, 4));
      console.log("✅ Phone number saved to database successfully:", phoneNumber);
    } else {
      console.error("❌ User record not found in database");
    }
  } catch (error) {
    console.error("❌ Error saving phone number to database:", error);
  }
}

// ===== ACTION HANDLERS =====

// 0. Mini-miranda handler
function handleMiniMiranda(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en'; // Use selected language
  console.log("📢 Mini-miranda for CallSid:", callSid, "Language:", lang);
  
  const vr = new VoiceResponse();
  addSayWithVoice(vr, MESSAGES[lang].miniMiranda, lang); // Use selected language
  
  // Check CSR availability and route accordingly
  if (areCSRAgentsAvailable()) {
    console.log("CSR agents available, skipping notice");
    s.currentStep = 'ask-question-type'; // Skip CSR notice, go directly to question type selection
  } else {
    console.log("CSR agents not available, showing notice");
    s.currentStep = 'csr-notice'; // Show unavailability notice
  }
  
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
  
  // Play English part with English voice
  addSayWithVoice(g, MESSAGES.en.languagePromptEn, 'en');
  
  // Play Spanish part with Spanish voice
  addSayWithVoice(g, MESSAGES.es.languagePromptEs, 'es');
  
  // Use English voice for fallback
  addSayWithVoice(vr, MESSAGES.en.noInput, 'en');
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
    s.currentStep = 'mini-miranda';  // Go to mini-miranda after language selection
    vr.redirect('/action');
  } else if (digit === '2') {
    s.language = 'es';
    s.currentStep = 'mini-miranda';  // Go to mini-miranda after language selection
    vr.redirect('/action');
  } else {
    s.attempts.language++;
    if (tooManyAttempts(vr, 'language', callSid, res)) return;
    addSayWithVoice(vr, MESSAGES.en.invalidLanguage, 'en');
    vr.redirect('/action?step=language-selection');
  }
  
  res.type('text/xml').send(vr.toString());
}

// 2. CSR notice handler (only called when agents are not available)
function handleCSRNotice(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("👥 CSR unavailable notice for CallSid:", callSid, "Language:", lang);
  
  const vr = new VoiceResponse();
  
  // Double-check availability (should be false if we got here)
  if (!areCSRAgentsAvailable()) {
    addSayWithVoice(vr, MESSAGES[lang].noCSRAgents, lang);
    console.log("📢 Played CSR unavailable message");
  } else {
    console.log("⚠️ Warning: CSR notice called but agents are available");
  }
  
  s.currentStep = 'ask-question-type';
  vr.redirect('/action');
  res.type('text/xml').send(vr.toString());
}

// 3. Question type prompt handler
function handleQuestionTypePrompt(req, res) {
  const callSid = req.body.CallSid;
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("❓ Question type prompt for CallSid:", callSid, "Language:", lang);
  
  const vr = new VoiceResponse();
  const g = vr.gather({
    input: 'dtmf',
    numDigits: 1,
    action: '/action?step=process-question-type',
    method: 'POST'
  });
  addSayWithVoice(g, MESSAGES[lang].questionTypePrompt, lang);
  addSayWithVoice(vr, MESSAGES[lang].noInput, lang);
  vr.redirect('/action?step=ask-question-type');
  res.type('text/xml').send(vr.toString());
}

function processQuestionType(req, res) {
  const callSid = req.body.CallSid;
  const digit = req.body.Digits;
  const s = getState(callSid);
  const lang = s.language || 'en';
  console.log("🔢 Question type selection for CallSid:", callSid, "Digit:", digit);
  
  const vr = new VoiceResponse();
  
  if (digit === '1') {
    // General information
    s.questionType = 'general';
    console.log("📋 Selected: General information");
    s.currentStep = 'transfer-call';
    vr.redirect('/action');
  } else if (digit === '2') {
    // Account-specific or payment
    s.questionType = 'account-specific';
    console.log("🏦 Selected: Account-specific/Payment");
    s.currentStep = 'ask-ssn';
    // Store phone number for later saving to DB
    const callerPhone = req.body.From;
    s.phoneNumber = callerPhone;
    console.log("📞 Capturing phone number for account verification:", callerPhone);
    console.log("💾 Phone number stored in state:", s.phoneNumber);
    vr.redirect('/action');
  } else {
    s.attempts.questionType++;
    if (tooManyAttempts(vr, 'questionType', callSid, res)) return;
    addSayWithVoice(vr, MESSAGES[lang].invalidQuestionType, lang);
    vr.redirect('/action?step=ask-question-type');
  }
  
  res.type('text/xml').send(vr.toString());
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
  addSayWithVoice(g, MESSAGES[lang].ssn4Prompt, lang);
  addSayWithVoice(vr, MESSAGES[lang].noInput, lang);
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
    addSayWithVoice(vr, MESSAGES[lang].invalidSSN, lang);
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
  addSayWithVoice(g, MESSAGES[lang].dobPrompt, lang);
  addSayWithVoice(vr, MESSAGES[lang].noInput, lang);
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
    addSayWithVoice(vr, MESSAGES[lang].invalidDOB, lang);
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
  addSayWithVoice(g, MESSAGES[lang].zipPrompt, lang);
  addSayWithVoice(vr, MESSAGES[lang].noInput, lang);
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
    addSayWithVoice(vr, MESSAGES[lang].invalidZIP, lang);
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
      console.log("📞 Phone number from state for saving:", s.phoneNumber);
      console.log("📋 Complete state object:", JSON.stringify(s, null, 2));
      // Save phone number to database
      await savePhoneNumberToDB(s.phoneNumber, record);
      
      addSayWithVoice(vr, MESSAGES[lang].verificationSuccess.replace('{name}', record.name), lang);
      s.currentStep = 'transfer-call';
      console.log("🔄 Setting currentStep to 'transfer-call'");
      console.log("🎯 About to redirect to /action for transfer");
      vr.redirect('/action');
    } else {
      console.log("❌ User verification failed");
      addSayWithVoice(vr, MESSAGES[lang].verificationFailed, lang);
      // Reset for another attempt
      s.currentStep = 'ask-ssn';
      s.attempts.last4ssn = 0;
      s.attempts.dob = 0;
      s.attempts.zip = 0;
      vr.redirect('/action');
    }
  } catch (error) {
    console.error("❌ Error verifying user:", error);
    addSayWithVoice(vr, MESSAGES[lang].systemError, lang);
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
  console.log("📱 Customer phone number:", s.phoneNumber);
  console.log("🎯 Target phone:", CONFIG.TARGET_PHONE);
  console.log("🏢 Twilio phone:", CONFIG.TWILIO_PHONE);
  
  const vr = new VoiceResponse();
  addSayWithVoice(vr, MESSAGES[lang].transferring, lang);
  
  const dial = vr.dial();
  if (s.questionType === 'account-specific' && s.phoneNumber) {
    // Transfer FROM customer's phone number for account-specific questions
    dial.number(CONFIG.TARGET_PHONE, { callerId: s.phoneNumber });
    console.log("📱 Transferring account-specific call TO:", CONFIG.TARGET_PHONE, "FROM:", s.phoneNumber);
  } else {
    // Transfer FROM Twilio's phone number for general questions  
    dial.number(CONFIG.TARGET_PHONE, { callerId: CONFIG.TWILIO_PHONE });
    console.log("📱 Transferring general call TO:", CONFIG.TARGET_PHONE, "FROM:", CONFIG.TWILIO_PHONE);
  }
  
  const twimlOutput = vr.toString();
  console.log("📄 Generated TwiML for transfer:");
  console.log(twimlOutput);
  
  res.type('text/xml').send(twimlOutput);
}

// ===== ROUTING =====

// Main entry point - starts the flow
app.post('/start', (req, res) => {
  const callSid = req.body.CallSid;
  const callerPhone = req.body.From;
  console.log("🎯 Starting complete IVR flow for CallSid:", callSid);
  console.log("📞 Caller phone number:", callerPhone);
  console.log("📋 Full request body:", JSON.stringify(req.body, null, 2));
  
  // Store the caller's phone number
  const s = getState(callSid);
  s.phoneNumber = callerPhone;
  s.currentStep = 'language-selection';  // Ask for language first
  
  console.log("💾 Stored phone number in state:", s.phoneNumber);
  
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
  
  // Ensure phone number is always available as backup
  if (!s.phoneNumber && req.body.From) {
    console.log("🔄 Backup: Setting phone number from request body:", req.body.From);
    s.phoneNumber = req.body.From;
  }
  
  const actionHandler = ACTIONS[step];
  if (actionHandler) {
    console.log("✅ Found action handler for step:", step);
    if (step === 'transfer-call') {
      console.log("📞 About to execute transfer-call action");
    }
    await actionHandler(req, res);
  } else {
    console.error("❌ Unknown action:", step);
    const vr = new VoiceResponse();
    addSayWithVoice(vr, MESSAGES[s.language || 'en'].systemError, s.language || 'en');
    vr.hangup();
    res.type('text/xml').send(vr.toString());
  }
});

app.listen(3000, () => console.log('🚀 Server running on port 3000'));

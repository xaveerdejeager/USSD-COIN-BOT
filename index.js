const express = require('express');
const axios = require('axios');
const { ethers } = require('ethers');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ussd_secret_123';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const userWallets = {};

function getOrCreateWallet(phone) {
  if (!userWallets[phone]) {
    const wallet = ethers.Wallet.createRandom();
    userWallets[phone] = { address: wallet.address, balance: 100 };
  }
  return userWallets[phone];
}

// 1. Meta WhatsApp Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2. Incoming WhatsApp Messages Handler
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.at(0);
    const message = entry?.changes?.at(0)?.value?.messages?.at(0);
    if (!message || !message.text) return;

    const from = message.from;
    const text = message.text.body.trim();
    const user = getOrCreateWallet(from);

    let reply = '';
    if (text.toLowerCase().includes('balance')) {
      reply = `💵 *USSD Dollar Wallet*\nPhone: +${from}\nBalance: *${user.balance.toFixed(2)} USSD* ($${user.balance.toFixed(2)})\nWallet ID: \`${user.address.slice(0, 8)}...\``;
    } else if (text.toLowerCase().startsWith('send')) {
      const parts = text.split(' ');
      const amount = parseFloat(parts.at(1));
      const recipient = parts.at(2)?.replace('+', '');
      if (!amount || amount <= 0 || !recipient) {
        reply = `❌ Format: *Send 10 +2348012345678*`;
      } else if (amount > user.balance) {
        reply = `❌ Insufficient funds. Your balance is *${user.balance.toFixed(2)} USSD*.`;
      } else {
        const target = getOrCreateWallet(recipient);
        user.balance -= amount;
        target.balance += amount;
        reply = `✅ Sent *${amount.toFixed(2)} USSD* to +${recipient}!\nNew Balance: *${user.balance.toFixed(2)} USSD*`;
      }
    } else {
      reply = `👋 Welcome to *USSD Coin ($USSD)*!\nYour invisible dollar wallet is active (100.00 USSD welcome test credit).\n\nReply with:\n• *Balance* — Check your $USSD\n• *Send 10 +2348012345678* — Send dollars to any phone number`;
    }

    if (WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
      await axios.post(
        `https://facebook.com{PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to: from,
          text: { body: reply }
        },
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
      );
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// 3. Instant Africa's Talking USSD Endpoint (<50ms response!)
app.post('/ussd', (req, res) => {
  const { phoneNumber, text } = req.body;
  const cleanPhone = (phoneNumber || '').replace('+', '');
  const user = getOrCreateWallet(cleanPhone);

  let response = '';
  if (!text || text === '') {
    response = `CON Welcome to USSD Dollar ($USSD)\n1. Check Balance\n2. Send $USSD\n3. Wallet Address`;
  } else if (text === '1') {
    response = `END Your Balance: ${user.balance.toFixed(2)} USSD ($${user.balance.toFixed(2)})`;
  } else if (text === '2') {
    response = `CON Enter recipient phone number (e.g. 2348012345678):`;
  } else if (text.startsWith('2*')) {
    const parts = text.split('*');
    if (parts.length === 2) {
      response = `CON Enter amount in USSD to send:`;
    } else if (parts.length === 3) {
      const recipient = parts.at(1)?.replace('+', '');
      const amount = parseFloat(parts.at(2));
      if (amount > 0 && amount <= user.balance) {
        const target = getOrCreateWallet(recipient);
        user.balance -= amount;
        target.balance += amount;
        response = `END Sent ${amount.toFixed(2)} USSD to +${recipient}! New Balance: ${user.balance.toFixed(2)} USSD`;
      } else {
        response = `END Invalid amount or insufficient balance.`;
      }
    }
  } else if (text === '3') {
    response = `END Your $USSD Wallet:\n${user.address}`;
  } else {
    response = `END Invalid selection.`;
  }

  res.set('Content-Type', 'text/plain');
  res.send(response);
});

app.get('/', (req, res) => res.send('USSD Coin Bot Server is Live!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  

  
   



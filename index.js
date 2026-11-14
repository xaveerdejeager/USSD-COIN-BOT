const express = require('express');
const axios = require('axios');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ussd_secret_123';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function getOrCreateWallet(phone) {
  const { data } = await supabase
    .from('wallets')
    .select('*')
    .eq('phone', phone)
    .single();

  if (data) return data;

  const wallet = ethers.Wallet.createRandom();
  const newUser = {
    phone,
    address: wallet.address,
    pin: null,
    balance: 100
  };
  await supabase.from('wallets').insert(newUser);
  return newUser;
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
    const user = await getOrCreateWallet(from);

    let reply = '';
    if (text.toLowerCase().includes('balance')) {
      reply = `💵 *USSD Dollar Wallet*\nPhone: +${from}\nBalance: *${Number(user.balance).toFixed(2)} USSD* ($${Number(user.balance).toFixed(2)})\nWallet ID: \`${user.address.slice(0, 8)}...\``;
    } else if (text.toLowerCase().startsWith('send')) {
      const parts = text.split(' ');
      const amount = parseFloat(parts.at(1));
      const recipient = parts.at(2)?.replace('+', '');
      if (!amount || amount <= 0 || !recipient) {
        reply = `❌ Format: *Send 10 +2348012345678*`;
      } else if (amount > Number(user.balance)) {
        reply = `❌ Insufficient funds. Your balance is *${Number(user.balance).toFixed(2)} USSD*.`;
      } else {
        const target = await getOrCreateWallet(recipient);
        const newSenderBal = Number(user.balance) - amount;
        const newTargetBal = Number(target.balance) + amount;
        await supabase.from('wallets').update({ balance: newSenderBal }).eq('phone', from);
        await supabase.from('wallets').update({ balance: newTargetBal }).eq('phone', recipient);
        reply = `✅ Sent *${amount.toFixed(2)} USSD* to +${recipient}!\nNew Balance: *${newSenderBal.toFixed(2)} USSD*`;
      }
    } else {
      reply = `👋 Welcome to *USSD Coin ($USSD)*!\nYour permanent dollar wallet is active (100.00 USSD welcome test credit).\n\nReply with:\n• *Balance* — Check your $USSD\n• *Send 10 +2348012345678* — Send dollars to any phone number`;
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

// 3. Africa's Talking USSD Endpoint with 4-Digit Security PIN + Supabase Storage
app.post('/ussd', async (req, res) => {
  try {
    const { phoneNumber, text } = req.body;
    const cleanPhone = (phoneNumber || '').replace('+', '');
    const user = await getOrCreateWallet(cleanPhone);

    let response = '';

    // Force first-time users to create a 4-digit PIN
    if (!user.pin) {
      if (!text || text === '') {
        response = `CON Welcome to USSD Dollar ($USSD)!\nCreate a 4-digit PIN to secure your wallet:`;
      } else if (/^\d{4}$/.test(text.trim())) {
        await supabase.from('wallets').update({ pin: text.trim() }).eq('phone', cleanPhone);
        response = `END PIN created successfully! Dial *384*51117# again to access your 100.00 USSD wallet.`;
      } else {
        response = `END Invalid PIN. Please dial *384*51117# again and enter exactly 4 digits (e.g. 1234).`;
      }
    } else if (!text || text === '') {
      response = `CON USSD Dollar ($USSD)\n1. Check Balance\n2. Send $USSD\n3. Wallet Address`;
    } else if (text === '1') {
      response = `END Your Balance: ${Number(user.balance).toFixed(2)} USSD ($${Number(user.balance).toFixed(2)})`;
    } else if (text === '2') {
      response = `CON Enter recipient phone number (e.g. 2348012345678):`;
    } else if (text.startsWith('2*')) {
      const parts = text.split('*');
      if (parts.length === 2) {
        response = `CON Enter amount in USSD to send:`;
      } else if (parts.length === 3) {
        response = `CON Enter your 4-digit PIN to confirm:`;
      } else if (parts.length === 4) {
        const recipient = parts.at(1)?.replace('+', '');
        const amount = parseFloat(parts.at(2));
        const enteredPin = parts.at(3)?.trim();

        if (enteredPin !== user.pin) {
          response = `END Incorrect PIN. Transaction cancelled.`;
        } else if (amount > 0 && amount <= Number(user.balance)) {
          const target = await getOrCreateWallet(recipient);
          const newSenderBal = Number(user.balance) - amount;
          const newTargetBal = Number(target.balance) + amount;

          await supabase.from('wallets').update({ balance: newSenderBal }).eq('phone', cleanPhone);
          await supabase.from('wallets').update({ balance: newTargetBal }).eq('phone', recipient);

          response = `END Sent ${amount.toFixed(2)} USSD to +${recipient}!\nNew Balance: ${newSenderBal.toFixed(2)} USSD`;
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
  } catch (err) {
    console.error('USSD error:', err.message);
    res.set('Content-Type', 'text/plain');
    res.send('END Temporary service error. Please try again.');
  }
});

app.get('/', (req, res) => res.send('USSD Coin Bot Server is Live!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

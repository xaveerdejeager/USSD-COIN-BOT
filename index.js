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

// Sepolia Blockchain Connection
const RPC_URL = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0x0fEC3876f7BE924472156Cb9cB39E60cBF3a3C89';
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)'
];


let ussdContract = null;
if (TREASURY_PRIVATE_KEY) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const treasuryWallet = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
  ussdContract = new ethers.Contract(CONTRACT_ADDRESS, ERC20_ABI, treasuryWallet);
}

// Background on-chain settlement so USSD never times out
async function settleOnChain(recipientPhone, recipientAddress, amount) {
  if (!ussdContract) return;
  try {
   const decimals = await ussdContract.decimals();
const weiAmount = ethers.parseUnits(amount.toString(), decimals);

    const tx = await ussdContract.transfer(recipientAddress, weiAmount);
    console.log(`On-chain tx sent: ${tx.hash}`);
    await supabase
      .from('wallets')
      .update({ last_tx: tx.hash })
      .eq('phone', recipientPhone);
  } catch (err) {
    console.error('On-chain settlement error:', err.message);
  }
}

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
      reply = `💵 *USSD Dollar Wallet*\nPhone: +${from}\nBalance: *${Number(user.balance).toFixed(2)} USSD* ($${Number(user.balance).toFixed(2)})\nWallet: \`${user.address}\``;
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
        settleOnChain(recipient, target.address, amount);
        reply = `✅ Sent *${amount.toFixed(2)} USSD* to +${recipient}!\nNew Balance: *${newSenderBal.toFixed(2)} USSD*`;
      }
    } else {
      reply = `👋 Welcome to *USSD Coin ($USSD)*!\nReply with:\n• *Balance*\n• *Send 10 +2348012345678*`;
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

// 3. Africa's Talking USSD Endpoint with PIN + Supabase + Sepolia On-Chain Settlement
app.post('/ussd', async (req, res) => {
  try {
    const { phoneNumber, text } = req.body;
    const cleanPhone = (phoneNumber || '').replace('+', '');
    const user = await getOrCreateWallet(cleanPhone);

    let response = '';

    if (!user.pin) {
      if (!text || text === '') {
        response = `CON Welcome to USSD Dollar ($USSD)!\nCreate a 4-digit PIN to secure your wallet:`;
      } else if (/^\d{4}$/.test(text.trim())) {
        await supabase.from('wallets').update({ pin: text.trim() }).eq('phone', cleanPhone);
        response = `END PIN created successfully! Dial *384*51117# again to access your 100.00 USSD wallet.`;
      } else {
        response = `END Invalid PIN. Dial *384*51117# and enter 4 digits.`;
      }
    } else if (!text || text === '') {
      response = `CON USSD Dollar ($USSD)\n1. Check Balance\n2. Send $USSD\n3. Wallet & Last Tx`;
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

          // Trigger real Sepolia ERC-20 transfer in background
          settleOnChain(recipient, target.address, amount);

          response = `END Sent ${amount.toFixed(2)} USSD to +${recipient}!\nSettling on Sepolia...\nNew Balance: ${newSenderBal.toFixed(2)} USSD`;
        } else {
          response = `END Invalid amount or insufficient balance.`;
        }
      }
    } else if (text === '3') {
      const txInfo = user.last_tx ? `\nLast Tx: ${user.last_tx.slice(0, 14)}...` : '';
      response = `END Wallet: ${user.address}${txInfo}`;
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

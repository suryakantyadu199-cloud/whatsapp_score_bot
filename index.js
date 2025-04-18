require('dotenv').config();

const { Client } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const CustomAuthStrategy = require('./CustomAuthStrategy');
const User = require('./models/User');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;

// ———————— Helpers ——————————————————

const isIncrement = msg => /^\+1$/.test(msg);
const isDecrement = msg => /^-1$/.test(msg);
const isNumeric = msg => /^\d+$/.test(msg);

async function getContactInfo(client, message) {
  if (message.from.includes('@g.us')) {
    const senderId = message.author;
    if (!senderId) throw new Error('No author en mensaje de grupo');
    const contact = await client.getContactById(senderId);
    return {
      id: senderId,
      name: contact.pushname || contact.verifiedName || contact.name || 'Usuario'
    };
  } else {
    const senderId = message.from;
    const contact = await message.getContact();
    return {
      id: senderId,
      name: contact.pushname || contact.verifiedName || contact.name || 'Usuario'
    };
  }
}

function getCurrentMonth() {
  const now = moment().tz(config.TIMEZONE);
  const start = now.clone().date(config.MONTH_START_DAY).startOf('day');
  return now.isBefore(start)
    ? now.subtract(1, 'months').format('MMMM')
    : now.format('MMMM');
}

async function generateRandomCongratsExtra(user) {
  const randomEmojis = ['🚬','📴','🇵🇪','🕵️‍♂️','🛋','❗','🦩','🧠','🪀','🥏','🌯','🍄','🪳','🔪','🗣️','🫛','🥜','🧑‍🦼','🦿'];
  const events = ['emoji', 'bestDay', 'worstDay', 'rival'];
  const choice = events[Math.floor(Math.random() * events.length)];

  if (choice === 'emoji') {
    return ` ${randomEmojis[Math.floor(Math.random() * randomEmojis.length)]}`;
  }

  const weekMap = user.week || new Map();
  const days = ['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
  const total = days.reduce((sum, d) => sum + (weekMap.get(d) || 0), 0);

  if (choice === 'bestDay') {
    let best = days[0], cnt = weekMap.get(best) || 0;
    days.forEach(d => {
      const c = weekMap.get(d) || 0;
      if (c > cnt) { cnt = c; best = d; }
    });
    const avgOther = ((total - cnt) / (days.length - 1)) || 0;
    const pct = avgOther > 0 ? Math.round(((cnt - avgOther) / avgOther) * 100) : 0;
    const dayCap = best.charAt(0).toUpperCase() + best.slice(1);
    return ` El ${dayCap} es el día que más puntos sueles sumar, sumando un ${pct}% más que el resto.`;
  }

  if (choice === 'worstDay') {
    let worst = days[0], cnt = weekMap.get(worst) || 0;
    days.forEach(d => {
      const c = weekMap.get(d) || 0;
      if (c < cnt) { cnt = c; worst = d; }
    });
    const avgOther = ((total - cnt) / (days.length - 1)) || 0;
    const pct = avgOther > 0 ? Math.round(((avgOther - cnt) / avgOther) * 100) : 0;
    const dayCap = worst.charAt(0).toUpperCase() + worst.slice(1);
    return ` El ${dayCap} es el día que menos puntos sueles sumar, sumando un ${pct}% menos que el resto.`;
  }

  // rival
  const others = await User.find({ _id: { $ne: user._id } });
  if (!others.length) return '';
  let closest = null, diff = Infinity;
  others.forEach(o => {
    const d = Math.abs(user.totalScore - o.totalScore);
    if (d < diff) { diff = d; closest = o; }
  });
  if (!closest) return '';
  const rivalName = (closest.displayName && closest.displayName !== 'Usuario')
    ? closest.displayName
    : closest._id;
  const relation = user.totalScore >= closest.totalScore ? 'por encima' : 'por debajo';
  return ` Tu rival más cercano es ${rivalName} con quien estás a ${diff} puntos de distancia ${relation}.`;
}

// ———————— DB & Client ——————————————————

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('MongoDB conectado'))
  .catch(err => console.error('Error conectando MongoDB:', err));

const client = new Client({
  authStrategy: new CustomAuthStrategy({ sessionId: 'default' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// Load commands
const commands = [];
fs.readdirSync(path.join(__dirname, 'commands'))
  .filter(f => f.endsWith('.js'))
  .forEach(f => commands.push(require(path.join(__dirname, 'commands', f))));

let shouldReply = true;
const setShouldReply = v => shouldReply = v;
const getShouldReply = () => shouldReply;

// ———————— Event Listeners ——————————————————

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('Escanea el QR para autenticar');
});

client.on('ready', () => {
  console.log('Bot listo!');
});

// Procesar "+1"/"-1"
async function processScoreChange(client, message) {
  try {
    const { id, name } = await getContactInfo(client, message);
    const msg = message.body.trim();
    const month = getCurrentMonth();
    const now = moment().tz(config.TIMEZONE);
    const hourKey = `h${now.hour()}`;
    const dayKey = now.format('dddd').toLowerCase();

    let user = await User.findById(id);
    if (!user) {
      user = new User({
        _id: id,
        displayName: name,
        totalScore: 0,
        monthlyScores: {},
        lastCongratulated: 0,
        hours: {},
        week: {}
      });
    } else if (user.displayName !== name && name !== 'Usuario') {
      user.displayName = name;
    }

    let score = user.monthlyScores.get(month) || 0;

    if (isIncrement(msg)) {
      score++;
      user.hours.set(hourKey, (user.hours.get(hourKey) || 0) + 1);
      user.week.set(dayKey, (user.week.get(dayKey) || 0) + 1);
    } else { // decrement
      if (score > 0) {
        score--;
        user.hours.set(hourKey, Math.max((user.hours.get(hourKey) || 0) - 1, 0));
        user.week.set(dayKey, Math.max((user.week.get(dayKey) || 0) - 1, 0));
      } else if (shouldReply) {
        await message.reply('Ya tienes 0 puntos en este mes, no puedes reducir más.');
        return;
      }
    }

    user.monthlyScores.set(month, score);
    user.totalScore = Array.from(user.monthlyScores.values()).reduce((a, b) => a + b, 0);

    if (user.totalScore >= user.lastCongratulated + 50 && user.totalScore % 50 === 0) {
      let text = `${user.displayName} acaba de alcanzar los ${user.totalScore} puntos!!!`;
      try {
        text += await generateRandomCongratsExtra(user);
      } catch (e) {
        console.error('Error extra felicitación:', e);
      }
      await client.sendMessage(message.from, text);
      user.lastCongratulated = user.totalScore;
    }

    await user.save();
    if (shouldReply) {
      await message.reply(`${score}✅`);
    }
  } catch (error) {
    console.error('Error al actualizar el puntaje:', error);
    if (shouldReply) {
      await message.reply(`Hubo un error al actualizar tu puntaje: ${error.message}`);
    }
  }
}

// Procesar mensaje numérico
async function processNumericMessage(client, message) {
  try {
    const { id, name } = await getContactInfo(client, message);
    const score = parseInt(message.body.trim(), 10);

    if (isNaN(score) || score < 0) {
      if (shouldReply) {
        await message.reply('Por favor, envía un número válido positivo.');
      }
      return;
    }

    const month = getCurrentMonth();
    let user = await User.findById(id);

    if (user) {
      user.monthlyScores.set(month, score);
      user.totalScore = Array.from(user.monthlyScores.values()).reduce((a, b) => a + b, 0);
      if (user.displayName !== name && name !== 'Usuario') {
        user.displayName = name;
      }
    } else {
      user = new User({
        _id: id,
        displayName: name,
        totalScore: score,
        monthlyScores: { [month]: score },
        lastCongratulated: score >= 50 && score % 50 === 0 ? score : 0,
        hours: {},
        week: {}
      });
      if (score >= 50 && score % 50 === 0) {
        await client.sendMessage(message.from, `${name} acaba de alcanzar los ${score} puntos!!!`);
      }
    }

    if (user.totalScore >= user.lastCongratulated + 50 && user.totalScore % 50 === 0) {
      await client.sendMessage(message.from, `${user.displayName} acaba de alcanzar los ${user.totalScore} puntos!!!`);
      user.lastCongratulated = user.totalScore;
    }

    await user.save();
    if (shouldReply) {
      await message.react('✅');
    }
  } catch (error) {
    console.error('Error al registrar tu puntaje:', error);
    if (shouldReply) {
      await message.reply(`Hubo un error al registrar tu puntaje: ${error.message}`);
    }
  }
}

client.on('message', async message => {
  try {
    const msg = message.body.trim();

    if (isIncrement(msg) || isDecrement(msg)) {
      await processScoreChange(client, message);
    } else if (isNumeric(msg)) {
      await processNumericMessage(client, message);
    } else {
      for (const cmd of commands) {
        if (cmd.match.test(msg)) {
          try {
            await cmd.callback(client, message, { setShouldReply, getShouldReply });
          } catch (e) {
            console.error('Error ejecutando comando:', e);
            if (shouldReply) {
              await message.reply('Hubo un error al ejecutar el comando.');
            }
          }
          break;
        }
      }
    }
  } catch (e) {
    console.error('Error procesando mensaje:', e);
  }
});

client.on('error', console.error);

client.initialize();

app.get('/', (_req, res) => res.send('Bot de WhatsApp está funcionando.'));
app.listen(PORT, () => console.log(`Servidor Express escuchando en el puerto ${PORT}`));

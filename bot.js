const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { readUsers, writeUsers } = require('./utils');

const app = express();
const port = 3000;

let users = readUsers();
let gruposDeshabilitados = [];
let sock;
let qrCodeData = '';
let connectionStatus = 'Desconectado';

app.use(express.static('public'));

app.get('/qr', (req, res) => {
    res.send(qrCodeData);
});

app.get('/status', (req, res) => {
    res.send(connectionStatus);
});

app.get('/logout', (req, res) => {
    const sessionPath = path.join(__dirname, 'session');
    fs.rmSync(sessionPath, { recursive: true, force: true });
    qrCodeData = '';
    connectionStatus = 'Desconectado';
    iniciarBot();
    res.send('Sesión cerrada. Escanea el nuevo código QR.');
});

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('session');
    sock = makeWASocket({ auth: state });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            qrCodeData = qr;
            connectionStatus = 'Desconectado';
        }
        if (connection === 'open') {
            console.log('✅ Bot conectado a WhatsApp');
            qrCodeData = '';
            connectionStatus = 'Conectado';
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Desconectado. Reconectando...', shouldReconnect);
            connectionStatus = 'Reconectando...';
            if (shouldReconnect) {
                setTimeout(iniciarBot, 5000); // Intentar reconectar después de 5 segundos
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (msg) => {
        try {
            const mensaje = msg.messages[0];
            if (!mensaje.message) return;

            const remitente = mensaje.key.participant || mensaje.key.remoteJid;
            const grupo = mensaje.key.remoteJid;
            const texto = mensaje.message.conversation || mensaje.message.extendedTextMessage?.text;

            if (!texto) return; // Asegurarse de que texto no sea undefined

            if (!users[remitente]) {
                users[remitente] = { dulces: 0, xp: 0, nivel: 0, admin: false };
            }

            // Verificar si el grupo está deshabilitado
            if (gruposDeshabilitados.includes(grupo)) {
                // Obtener la lista de administradores del grupo
                const groupMetadata = await sock.groupMetadata(grupo);
                const admins = groupMetadata.participants.filter(participant => participant.admin === 'admin' || participant.admin === 'superadmin').map(participant => participant.id);

                // Verificar si el remitente es un administrador
                if (!admins.includes(remitente)) {
                    return;
                }
            }

            // Cargar y ejecutar comandos
            const commandDirs = ['info', 'busquedas', 'juegos', 'rpg', 'stickers', 'admin', 'onoff'];
            for (const dir of commandDirs) {
                const commandFiles = fs.readdirSync(path.join(__dirname, 'commands', dir)).filter(file => file.endsWith('.js'));
                for (const file of commandFiles) {
                    const command = require(`./commands/${dir}/${file}`);
                    if (command.match && command.execute && command.match(texto)) {
                        await command.execute(sock, mensaje, texto, users, gruposDeshabilitados);
                        break;
                    }
                }
            }

            // Verificar respuestas a acertijos
            const acertijosCommand = require('./commands/juegos/acertijos');
            await acertijosCommand.verificarRespuesta(sock, mensaje, users);

            // Verificar respuestas a ordena la palabra
            const ordenaCommand = require('./commands/juegos/ordena');
            await ordenaCommand.verificarRespuesta(sock, mensaje, users);

            // Verificar respuestas a películas
            const peliculasCommand = require('./commands/juegos/peliculas');
            await peliculasCommand.verificarRespuesta(sock, mensaje, users);

            // Verificar respuestas a trivia
            const triviaCommand = require('./commands/juegos/trivia');
            await triviaCommand.verificarRespuesta(sock, mensaje, users);
            
            // ✅ Verificar respuestas al juego de apostar
            const apostarCommand = require('./commands/juegos/apostar');
            await apostarCommand.verificarRespuesta(sock, mensaje, users, juegos);

            writeUsers(users); // Guardar los datos de los usuarios después de procesar los mensajes
        } catch (error) {
            console.error('Error procesando mensaje:', error);
        }
    });
}

iniciarBot();

app.listen(port, () => {
    console.log(`Servidor web iniciado en http://localhost:${port}`);
});
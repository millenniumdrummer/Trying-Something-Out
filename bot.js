const Discord = require("discord.js");
const request = require("request");
const ffmpeg = require('fluent-ffmpeg');
const WitSpeech = require('node-witai-speech');
const decode = require('./decodeOpus.js');
const fs = require('fs');
const path = require('path');
const opus = require('node-opus');

var config = JSON.parse(fs.readFileSync("./settings.json", "utf-8"));

const WIT_API_KEY = config.wit_api_key;
const bot_controller = config.bot_controller;
const prefix = config.prefix;
const discord_token = config.discord_token;
const content_type = config.content_type;

const client = new Discord.Client();
const recordingsPath = makeDir('./recordings');
var queue = [];
var isPlaying = false;
var dispatcher = null;
var voiceChannel = null;
var textChannel = null;
var listenConnection = null;
var listenReceiver = null;
var listenStreams = new Map();
var skipReq = 0;
var skippers = [];
var listening = false;





client.login(discord_token);

client.on('ready', handleReady.bind(this));

client.on('message', handleMessage.bind(this));

client.on('guildMemberSpeaking', handleSpeaking.bind(this));

function handleReady() {
  console.log("[INFO] Bot is ready to deploy!");
}

function handleMessage(message) {
  if (!message.content.startsWith(prefix)) {
    return;
  }
  var command = message.content.toLowerCase().slice(1).split(' ');
  if ((command[0] == 'play' && command[1] == 'list') || command[0] == 'playlist') {
    command = 'playlist';
  }
  else {
    command = command[0];
  }

  switch (command) {
    case 'leave':
      commandLeave();
      break;
    case 'listen':
      textChannel = message.channel;
      commandListen(message);
      break;
    case 'stop':
      commandStop();
      break;
    default:
      message.reply(" command not recognized! Type '!help' for a list of commands.");
  }
}

function handleSpeech(member, speech) {
  console.log("[DEBUG] Bot is listening to" + member + " via handleSpeech function")
  var command = speech.toLowerCase().split(' ');
  if ((command[0] == 'play' && command[1] == 'list') || command[0] == 'playlist') {
    command = 'playlist';
  }
  else {
    command = command[0];
  }
  switch (command) {
    case 'listen':
      speechListen();
      break;
    case 'leave':
      speechLeave();
      break;
    case 'play':
      commandPlay(member, speech);
      break;
    case 'playlist':
      commandPlaylist(member, speech);
      break;
    case 'skip':
    case 'next':
      commandSkip();
      break;
    case 'pause':
      commandPause();
      break;
    case 'resume':
      commandResume();
      break;
    case 'stop':
      commandStop();
      break;
    case 'reset':
    case 'clear':
      commandReset();
      break;
    case 'repeat':
      commandRepeat(member, speech);
      break;
    case 'image':
      commandImage(member, speech);
      break;
    default:
      user = member.toString();
      textChannel.send(user.slice(0) + " said: " + speech);
  }
}

function handleSpeaking(member, speaking) {
  console.log("[DEBUG] Bot is listening to" + member + " via handleSpeaking function") 
  // Close the writeStream when a member stops speaking
  if (!speaking && member.voiceChannel) {
    console.log("[DEBUG] Awaiting speech")
    let stream =  listenStreams.get(member.id);
    console.log("[DEBUG] Stream is " + listenStreams.get(member.id));
    console.log("[DEBUG] Member id is " + member.id);
    if (stream) {
      console.log("[DEBUG] I hear something...");
      listenStreams.delete(member.id);
      stream.end(err => {
        if (err) {
          console.error(err);
        }

        let basename = path.basename(stream.path, '.opus_string');
        let text = "default";

        // decode file into pcm
        decode.convertOpusStringToRawPCM(stream.path,
          basename,
          (function() {
            processRawToWav(
              path.join('./recordings', basename + '.raw_pcm'),
              path.join('./recordings', basename + '.wav'),
              (function(data) {
                if (data != null) {
                  console.log("[DEBUG] Data is null in handleSpeakling function")
                  handleSpeech(member, data._text);
                }
              }).bind(this))
          }).bind(this));
      });
    }
  }
}


function commandListen(message) {
  member = message.member;
  if (!member) {
    return;
  }
  if (!member.voiceChannel) {
    message.reply(" you need to be in a voice channel first.")
    return;
  }
  if (listening) {
    message.reply(" a voice channel is already being listened to!");
    return;
  }

  listening = true;
  voiceChannel = member.voiceChannel;
  textChannel.send('Listening in to **' + member.voiceChannel.name + '**!');

  var recordingsPath = path.join('.', 'recordings');
  makeDir(recordingsPath);

  voiceChannel.join().then((connection) => {
    //listenConnection.set(member.voiceChannelId, connection);
    listenConnection = connection;
    console.log("[DEBUG] Listening in on channel");

    let receiver = connection.createReceiver();
    receiver.on('opus', function(user, data) {
      let hexString = data.toString('hex');
      let stream = listenStreams.get(user.id);
      if (!stream) {
        if (hexString === 'f8fffe') {
          return;
        }
        let outputPath = path.join(recordingsPath, `${user.id}-${Date.now()}.opus_string`);
        stream = fs.createWriteStream(outputPath);
        console.log("[DEBUG] Map is " + user.id + stream);
        listenStreams.set(user.id, stream);
      }
      stream.write(`,${hexString}`);
    });
    //listenReceiver.set(member.voiceChannelId, receiver);
    listenReceiver = receiver;
  }).catch(console.error);
}

function commandStop() {
  if (listenReceiver) {
    listening = false;
    listenReceiver.destroy();
    listenReceiver = null;
    textChannel.send("Stopped listening!");
  }
}

function commandLeave() {
  listening = false;
  queue = []
  if (dispatcher) {
    dispatcher.end();
  }
  dispatcher = null;
  commandStop();
  if (listenReceiver) {
    listenReceiver.destroy();
    listenReceiver = null;
  }
  if (listenConnection) {
    listenConnection.disconnect();
    listenConnection = null;
  }
  if (voiceChannel) {
    voiceChannel.leave();
    voiceChannel = null;
  }
}


function processRawToWav(filepath, outputpath, cb) {
  fs.closeSync(fs.openSync(outputpath, 'w'));
  var command = ffmpeg(filepath)
    .addInputOptions([
      '-f s32le',
      '-ar 48k',
      '-ac 1'
    ])
    .on('end', function() {
      // Stream the file to be sent to the wit.ai
      var stream = fs.createReadStream(outputpath);

      // Its best to return a promise
      var parseSpeech =  new Promise((ressolve, reject) => {
      // call the wit.ai api with the created stream
      WitSpeech.extractSpeechIntent(WIT_API_KEY, stream, content_type,
      (err, res) => {
          if (err) return reject(err);
          ressolve(res);
        });
      });

      // check in the promise for the completion of call to witai
      parseSpeech.then((data) => {
        console.log("you said: " + data._text);
        cb(data);
        //return data;
      })
      .catch((err) => {
        console.log(err);
        cb(null);
        //return null;
      })
    })
    .on('error', function(err) {
        console.log('an error happened: ' + err.message);
    })
    .addOutput(outputpath)
    .run();
}

function makeDir(dir) {
  try {
    fs.mkdirSync(dir);
  } catch (err) {}
}

function reduceTrailingWhitespace(string) {
  for (var i = string.length - 1; i >= 0; i--) {
    if (string.charAt(i) == ' ') string = string.slice(0, i);
    else return string;
  }
  return string;
}
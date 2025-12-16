import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

const {
  PORT = 10000,
  TWILIO_AUTH_TOKEN
} = process.env;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const MessagingResponse = twilio.twiml.MessagingResponse;

// Webhook de WhatsApp
app.post("/whatsapp", (req, res) => {
  // Twilio firma la petición; opcional validar con TWILIO_AUTH_TOKEN
  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  console.log("Mensaje entrante:", from, body);

  const twiml = new MessagingResponse();
  twiml.message(
    "👋 Hola, soy *Promobolsillo* (demo Render).\n\n" +
    "Voy a ser tu asistente para Operación y Academia."
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`🚀 Promobolsillo bot escuchando en puerto ${PORT}`);
});

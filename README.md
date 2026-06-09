# ⚡ QuizLive — Application Quiz Temps Réel Multijoueur

Application PWA multijoueur avec classement en temps réel, chronomètre et QR code.

## 🚀 Installation

```bash
# 1. Installer les dépendances
npm install

# 2. Lancer le serveur
npm start
```

L'app tourne sur **http://localhost:3000**

## 📱 Utilisation

### Interface Animateur
Ouvrez **http://localhost:3000/host.html** sur votre PC/TV.

1. Saisissez vos questions (ou modifiez les exemples)
2. Cliquez **Créer la salle**
3. Un QR code + code à 5 lettres s'affichent
4. Attendez que les joueurs rejoignent
5. Cliquez **Démarrer la partie**

### Interface Joueur (PWA)
Les joueurs scannent le QR code ou vont sur **http://[votre-ip]:3000/?room=XXXXX**

- Entrent le code et leur pseudo
- Répondent en tapant sur les boutons colorés
- Voient leur score et le classement en direct

L'app peut s'installer sur l'écran d'accueil du téléphone (PWA).

## 🌐 Déploiement sur un vrai serveur

### Option A — VPS / serveur dédié
```bash
# Installer Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Cloner/copier le projet
cd /var/www/quizlive
npm install

# Lancer avec PM2 (process manager)
npm install -g pm2
pm2 start server.js --name quizlive
pm2 startup && pm2 save
```

### Option B — Railway / Render / Fly.io
Ces plateformes déploient directement depuis GitHub, gratuitement.

### Option C — Avec Nginx (HTTPS pour PWA complète)
```nginx
server {
    listen 443 ssl;
    server_name quiz.mondomaine.fr;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

> ⚠️ **HTTPS obligatoire** pour l'installation PWA sur mobile.

## 🎮 Système de score

| Condition | Points |
|-----------|--------|
| Bonne réponse | 1000 pts |
| Bonus rapidité (max) | +500 pts |
| Mauvaise réponse | 0 pts |

Le bonus de rapidité diminue linéairement : répondre en 1 seconde ≈ +500 pts, à la dernière seconde ≈ 0 pts.

## 📁 Structure du projet

```
quizlive/
├── server.js          # Serveur Node.js + Socket.io
├── package.json
└── public/
    ├── index.html     # Page joueur
    ├── host.html      # Page animateur
    ├── manifest.json  # Config PWA
    ├── sw.js          # Service Worker
    ├── css/
    │   └── style.css
    ├── js/
    │   ├── player.js
    │   └── host.js
    └── icons/
        ├── icon-192.png
        └── icon-512.png
```

## ⚙️ Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT`   | 3000   | Port du serveur |

## 🔧 Personnalisation

### Ajouter des questions en JSON
Vous pouvez charger des questions depuis un fichier via l'API :
```json
[
  {
    "question": "Ma question ?",
    "answers": ["A", "B", "C", "D"],
    "correct": 0,
    "time": 20
  }
]
```

### Modifier le design
Toutes les couleurs sont des variables CSS dans `public/css/style.css` (section `:root`).

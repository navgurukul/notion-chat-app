# Installation Guide

Follow these steps to get the Notion AI Chat Assistant running on your local machine.

## 1. Clone the Repository

```bash
git clone https://github.com/navgurukul/notion-chat-app.git
cd notion-chat-app
```

## 2. Install Dependencies

We use `npm` for package management.

```bash
npm install
```

## 3. Environment Setup

Copy the example environment file and fill in your credentials.

```bash
cp .env.example .env.local
```

Refer to the [Configuration](Configuration) page for details on how to get your keys.

## 4. Run Development Server

```bash
npm run dev
```

Visit `http://localhost:3000` to see the app in action!

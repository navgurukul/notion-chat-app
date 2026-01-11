import { openDB, IDBPDatabase } from 'idb';

const DB_NAME = 'notion-ai-chat';
const STORE_NAME = 'messages';
const DB_VERSION = 1;

interface Message {
    role: 'user' | 'bot';
    content: string;
    timestamp: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

const getDB = () => {
    if (typeof window === 'undefined') return null;
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'timestamp' });
                }
            },
        });
    }
    return dbPromise;
};

export async function saveMessage(message: Omit<Message, 'timestamp'>) {
    const db = await getDB();
    if (!db) return;
    await db.add(STORE_NAME, {
        ...message,
        timestamp: Date.now(),
    });
}

export async function getMessages(): Promise<Message[]> {
    const db = await getDB();
    if (!db) return [];
    return db.getAll(STORE_NAME);
}

export async function clearMessages() {
    const db = await getDB();
    if (!db) return;
    await db.clear(STORE_NAME);
}

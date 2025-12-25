// Import Firebase SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-analytics.js";
import { 
    getAuth, signInAnonymously, onAuthStateChanged, updateProfile 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { 
    getFirestore, collection, addDoc, query, where, onSnapshot, 
    orderBy, serverTimestamp, doc, setDoc, getDoc, updateDoc, arrayUnion 
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// Your Config
const firebaseConfig = {
    apiKey: "AIzaSyAzSWYQzLxYhWQjBvbHTAueqZ3bqq2QC1U",
    authDomain: "pvt-chats.firebaseapp.com",
    projectId: "pvt-chats",
    storageBucket: "pvt-chats.firebasestorage.app",
    messagingSenderId: "294532444552",
    appId: "1:294532444552:web:f729c03fd46ea8569f0a3d",
    measurementId: "G-0530G7T86J"
};

// Initialize
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

// State
let currentUser = null;
let currentChatId = null;
let unsubscribeMessages = null;

// DOM Elements
const loginModal = document.getElementById('login-modal');
const usernameInput = document.getElementById('username-input');
const loginBtn = document.getElementById('login-btn');
const chatListEl = document.getElementById('chat-list');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const sidebar = document.getElementById('sidebar');
const activeChatView = document.getElementById('active-chat');
const emptyState = document.getElementById('empty-state');
const groupModal = document.getElementById('group-modal');

// --- 1. Authentication & Invite Logic ---

onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        loginModal.classList.add('hidden');
        document.getElementById('my-name').textContent = user.displayName || 'Anonymous';
        document.getElementById('my-avatar').textContent = (user.displayName || 'A')[0];
        
        loadChats();
        checkUrlForInvite();
    } else {
        loginModal.classList.remove('hidden');
    }
});

loginBtn.addEventListener('click', () => {
    const name = usernameInput.value.trim();
    if (!name) return;

    signInAnonymously(auth).then((result) => {
        updateProfile(result.user, { displayName: name }).then(() => {
            // Save user to DB so others can find them by ID
            setDoc(doc(db, "users", result.user.uid), {
                uid: result.user.uid,
                displayName: name,
                photoURL: null
            }, { merge: true });
            location.reload(); // Refresh to update UI
        });
    });
});

// --- 2. Invite System (The "Link" Feature) ---
// Logic: If URL has ?invite=USER_ID, create a chat with that user automatically.

async function checkUrlForInvite() {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteUid = urlParams.get('invite');

    if (inviteUid && inviteUid !== currentUser.uid) {
        // Check if chat already exists
        const q = query(
            collection(db, "chats"), 
            where("participants", "array-contains", currentUser.uid),
            where("type", "==", "private")
        );
        
        // This is a simplified client-side check. In prod, use a better compound query or Cloud Function.
        // We will just create a unique ID for private chats: sort(uid1, uid2)
        const participants = [currentUser.uid, inviteUid].sort();
        const chatId = participants.join("_");

        const chatRef = doc(db, "chats", chatId);
        const chatSnap = await getDoc(chatRef);

        if (!chatSnap.exists()) {
            // Fetch invitee name
            const inviteeSnap = await getDoc(doc(db, "users", inviteUid));
            const inviteeName = inviteeSnap.exists() ? inviteeSnap.data().displayName : "Unknown";

            await setDoc(chatRef, {
                type: 'private',
                participants: participants,
                participantNames: {
                    [currentUser.uid]: currentUser.displayName,
                    [inviteUid]: inviteeName
                },
                lastMessage: "Chat created via link",
                timestamp: serverTimestamp()
            });
        }
        
        // Clean URL
        window.history.replaceState({}, document.title, "/");
        selectChat(chatId, inviteUid); // Open the chat
    }
}

// --- 3. Chat List & Realtime Updates ---

function loadChats() {
    const q = query(
        collection(db, "chats"), 
        where("participants", "array-contains", currentUser.uid),
        orderBy("timestamp", "desc")
    );

    onSnapshot(q, (snapshot) => {
        chatListEl.innerHTML = "";
        snapshot.forEach((doc) => {
            const data = doc.data();
            const chatId = doc.id;
            
            // Determine Chat Name
            let chatName = "Chat";
            if (data.type === 'group') {
                chatName = data.groupName;
            } else {
                // For private, find the OTHER user's name
                const otherUid = data.participants.find(uid => uid !== currentUser.uid);
                chatName = data.participantNames ? data.participantNames[otherUid] : "User";
            }

            const div = document.createElement('div');
            div.className = `chat-item ${currentChatId === chatId ? 'active' : ''}`;
            div.innerHTML = `
                <div class="avatar">${chatName[0]}</div>
                <div class="chat-info">
                    <h4>${chatName}</h4>
                    <p>${data.lastMessage || 'No messages yet'}</p>
                </div>
            `;
            div.addEventListener('click', () => selectChat(chatId, data));
            chatListEl.appendChild(div);
        });
    });
}

// --- 4. Messaging Logic ---

function selectChat(chatId, chatData) {
    currentChatId = chatId;
    
    // UI Updates
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    // Mobile toggle
    if (window.innerWidth <= 768) {
        sidebar.classList.add('hidden-mobile');
    }
    emptyState.classList.add('hidden');
    activeChatView.classList.remove('hidden');

    // Set Header Info
    let headerName = "Chat";
    if (chatData.type === 'group') headerName = chatData.groupName;
    else {
        const otherUid = chatData.participants.find(uid => uid !== currentUser.uid);
        headerName = chatData.participantNames ? chatData.participantNames[otherUid] : "User";
    }
    document.getElementById('current-chat-name').textContent = headerName;
    document.getElementById('current-chat-status').textContent = chatData.type === 'group' ? 'Group Chat' : 'Private';

    // Load Messages
    if (unsubscribeMessages) unsubscribeMessages();
    
    const q = query(
        collection(db, "chats", chatId, "messages"),
        orderBy("timestamp", "asc")
    );

    unsubscribeMessages = onSnapshot(q, (snapshot) => {
        messagesContainer.innerHTML = "";
        snapshot.forEach((doc) => {
            renderMessage(doc.data());
        });
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
}

function renderMessage(msg) {
    const div = document.createElement('div');
    const isOwn = msg.senderId === currentUser.uid;
    div.className = `message ${isOwn ? 'own' : 'their'}`;
    
    let content = '';
    if (!isOwn && msg.senderName) content += `<span class="sender-name">${msg.senderName}</span>`;
    content += `${msg.text} <span class="message-meta">${formatTime(msg.timestamp)}</span>`;
    
    div.innerHTML = content;
    messagesContainer.appendChild(div);
}

// Send Message
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentChatId) return;
    
    messageInput.value = ""; // Clear immediately for UX

    await addDoc(collection(db, "chats", currentChatId, "messages"), {
        text: text,
        senderId: currentUser.uid,
        senderName: currentUser.displayName,
        timestamp: serverTimestamp()
    });

    await updateDoc(doc(db, "chats", currentChatId), {
        lastMessage: text,
        timestamp: serverTimestamp()
    });
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') sendMessage(); });

// --- 5. Group Chat & Utilities ---

// Create Group Modal
document.getElementById('create-group-btn').addEventListener('click', () => groupModal.classList.remove('hidden'));
document.getElementById('close-group-modal').addEventListener('click', () => groupModal.classList.add('hidden'));

document.getElementById('create-group-confirm').addEventListener('click', async () => {
    const groupName = document.getElementById('group-name-input').value;
    if (!groupName) return;

    await addDoc(collection(db, "chats"), {
        type: 'group',
        groupName: groupName,
        participants: [currentUser.uid],
        lastMessage: "Group Created",
        timestamp: serverTimestamp()
    });
    groupModal.classList.add('hidden');
});

// Copy Invite Link
window.copyInviteLink = function() {
    const link = `${window.location.origin}${window.location.pathname}?invite=${currentUser.uid}`;
    navigator.clipboard.writeText(link);
    showToast();
};

document.getElementById('copy-link-btn').addEventListener('click', window.copyInviteLink);

// Mobile Back Button
document.getElementById('back-btn').addEventListener('click', () => {
    sidebar.classList.remove('hidden-mobile');
    activeChatView.classList.add('hidden');
    currentChatId = null;
});

// Helpers
function formatTime(timestamp) {
    if (!timestamp) return '...';
    const date = timestamp.toDate();
    return date.getHours() + ':' + (date.getMinutes()<10?'0':'') + date.getMinutes();
}

function showToast() {
    const toast = document.getElementById('toast');
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2000);
                                                     }

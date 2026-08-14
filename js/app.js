app_js_content = """/**
 * BOYWO - Boost Your Work
 * Main Application Logic (app.js)
 */

document.addEventListener('DOMContentLoaded', () => {
    // Initialize modules
    initClock();
    initNavigation();
    initTasks();
    initNotes();
    initWeather();
});

/* ==========================================
   1. HORLOGE ET DATE EN TEMPS RÉEL
   ========================================== */
function initClock() {
    const timeEl = document.getElementById('clock-time') || document.querySelector('.clock-time');
    const dateEl = document.getElementById('clock-date') || document.querySelector('.clock-date');

    function updateClock() {
        const now = new Date();
        
        if (timeEl) {
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');
            timeEl.textContent = `${hours}:${minutes}`;
        }

        if (dateEl) {
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            const formattedDate = now.toLocaleDateString('fr-FR', options);
            dateEl.textContent = formattedDate;
        }
    }

    updateClock();
    setInterval(updateClock, 1000);
}

/* ==========================================
   2. NAVIGATION ET ONGLETS
   ========================================== */
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item, [data-tab]');
    const tabContents = document.querySelectorAll('.tab-content, .section-content');

    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetTab = item.getAttribute('data-tab') || item.getAttribute('href')?.replace('#', '');

            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            if (targetTab) {
                tabContents.forEach(content => {
                    if (content.id === targetTab) {
                        content.classList.add('active');
                        content.style.display = 'block';
                    } else {
                        content.classList.remove('active');
                        content.style.display = 'none';
                    }
                });
            }
        });
    });
}

/* ==========================================
   3. GESTION DES TÂCHES (TODOLIST)
   ========================================== */
function initTasks() {
    const addTaskBtn = document.querySelector('#add-task-btn, .btn-add-task');
    const taskList = document.querySelector('#task-list, .task-list');

    let tasks = JSON.parse(localStorage.getItem('boywo_tasks')) || [
        { id: 1, text: 'Rédiger le rapport hebdomadaire', completed: false },
        { id: 2, text: 'Mettre à jour le projet BOYWO', completed: true }
    ];

    function saveAndRenderTasks() {
        localStorage.setItem('boywo_tasks', JSON.stringify(tasks));
        renderTasks();
    }

    function renderTasks() {
        if (!taskList) return;
        taskList.innerHTML = '';

        if (tasks.length === 0) {
            taskList.innerHTML = '<p class="empty-msg">Aucune tâche pour le moment.</p>';
            return;
        }

        tasks.forEach(task => {
            const li = document.createElement('li');
            li.className = `task-item ${task.completed ? 'completed' : ''}`;
            li.innerHTML = `
                <label class="task-checkbox-container">
                    <input type="checkbox" ${task.completed ? 'checked' : ''} data-id="${task.id}">
                    <span class="checkmark"></span>
                    <span class="task-text">${escapeHtml(task.text)}</span>
                </label>
                <button class="btn-delete-task" data-id="${task.id}">&times;</button>
            `;

            // Checkbox handler
            li.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
                const id = parseInt(e.target.getAttribute('data-id'));
                const t = tasks.find(item => item.id === id);
                if (t) {
                    t.completed = e.target.checked;
                    saveAndRenderTasks();
                }
            });

            // Delete handler
            li.querySelector('.btn-delete-task').addEventListener('click', (e) => {
                const id = parseInt(e.target.getAttribute('data-id'));
                tasks = tasks.filter(item => item.id !== id);
                saveAndRenderTasks();
            });

            taskList.appendChild(li);
        });
    }

    if (addTaskBtn) {
        addTaskBtn.addEventListener('click', () => {
            const taskText = prompt('Entrez la nouvelle tâche :');
            if (taskText && taskText.trim() !== '') {
                tasks.push({
                    id: Date.now(),
                    text: taskText.trim(),
                    completed: false
                });
                saveAndRenderTasks();
            }
        });
    }

    renderTasks();
}

/* ==========================================
   4. GESTION DES NOTES
   ========================================== */
function initNotes() {
    const addNoteBtn = document.querySelector('#add-note-btn, .btn-add-note');
    const notesGrid = document.querySelector('#notes-grid, .notes-container');

    let notes = JSON.parse(localStorage.getItem('boywo_notes')) || [
        { id: 1, title: 'Idée projet', content: 'Optimiser l\'interface utilisateur et ajouter des raccourcis.' }
    ];

    function saveAndRenderNotes() {
        localStorage.setItem('boywo_notes', JSON.stringify(notes));
        renderNotes();
    }

    function renderNotes() {
        if (!notesGrid) return;
        notesGrid.innerHTML = '';

        if (notes.length === 0) {
            notesGrid.innerHTML = '<p class="empty-msg">Aucune note sauvegardée.</p>';
            return;
        }

        notes.forEach(note => {
            const card = document.createElement('div');
            card.className = 'note-card';
            card.innerHTML = `
                <h4>${escapeHtml(note.title)}</h4>
                <p>${escapeHtml(note.content)}</p>
                <button class="btn-delete-note" data-id="${note.id}">Supprimer</button>
            `;

            card.querySelector('.btn-delete-note').addEventListener('click', () => {
                notes = notes.filter(n => n.id !== note.id);
                saveAndRenderNotes();
            });

            notesGrid.appendChild(card);
        });
    }

    if (addNoteBtn) {
        addNoteBtn.addEventListener('click', () => {
            const title = prompt('Titre de la note :');
            if (title) {
                const content = prompt('Contenu de la note :') || '';
                notes.push({
                    id: Date.now(),
                    title: title.trim(),
                    content: content.trim()
                });
                saveAndRenderNotes();
            }
        });
    }

    renderNotes();
}

/* ==========================================
   5. MÉTÉO ET RENSEIGNEMENTS
   ========================================== */
function initWeather() {
    const weatherTemp = document.querySelector('.weather-temp');
    const weatherCity = document.querySelector('.weather-city');

    // Simulation ou appel d'API si disponible
    if (weatherCity && weatherTemp) {
        // Antananarivo par défaut
        weatherCity.textContent = 'Antananarivo';
        weatherTemp.textContent = '22°C ⛅';
    }
}

// Utilitaire de sécurisation du texte HTML
function escapeHtml(str) {
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
}
"""

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(app_js_content)

print("File app.js successfully generated.")

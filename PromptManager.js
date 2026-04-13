import fs from 'fs';
import YAML from 'yaml';
import logger from './logger.js';

class PromptManager {
    constructor() {
        this.prompts = {};
        this.loadConfig('ko', './prompts_ko.yml');
        this.loadConfig('en', './prompts_en.yml');
    }

    // 설정 파일 로드
    loadConfig(lang, filePath) {
        try {
            if (fs.existsSync(filePath)) {
                const file = fs.readFileSync(filePath, 'utf8');
                const config = YAML.parse(file);
                this.prompts[lang] = config.tasks;
                logger.success(`Prompt configuration (${lang}) loaded successfully.`);
            } else {
                logger.warn(`Prompt file not found: ${filePath}`);
                this.prompts[lang] = {};
            }
        } catch (error) {
            logger.error(`Failed to load ${filePath}:`, error.message);
        }
    }

    // 템플릿 변수 치환 및 최종 프롬프트 생성
    getPrompt(taskId, lang = 'ko', data = {}) {
        const tasks = this.prompts[lang] || this.prompts['ko'];
        const task = tasks[taskId];
        if (!task) {
            throw new Error(`Task [${taskId}] not found in configuration for language [${lang}].`);
        }

        // 1. 기본 구조 결합 (페르소나 + 지시문 + 규칙)
        let finalPrompt = `[Persona]\n${task.persona}\n\n`;
        finalPrompt += `[Instruction]\n${task.instruction}\n\n`;
        
        if (task.rules) {
            finalPrompt += `[Rules]\n${task.rules.map(r => `- ${r}`).join('\n')}\n\n`;
        }

        if (task.format_rules) {
            finalPrompt += `[Format]\n${task.format_rules}\n\n`;
        }

        finalPrompt += `[Content]\n${task.template}`;

        // 2. 전체 프롬프트에서 템플릿 변수 치환 (중요: template뿐만 아니라 rules 등 전체 적용)
        Object.keys(data).forEach(key => {
            const regex = new RegExp(`{{${key}}}`, 'g');
            finalPrompt = finalPrompt.replace(regex, data[key]);
        });

        return finalPrompt;
    }
}

export default new PromptManager();

import fs from 'fs';
import YAML from 'yaml';

class PromptManager {
    constructor() {
        this.prompts = {};
        this.loadConfig();
    }

    // 설정 파일 로드
    loadConfig() {
        try {
            const file = fs.readFileSync('./prompts.yml', 'utf8');
            const config = YAML.parse(file);
            this.prompts = config.tasks;
            console.log('✅ Prompt configuration loaded successfully.');
        } catch (error) {
            console.error('❌ Failed to load prompts.yml:', error.message);
        }
    }

    // 템플릿 변수 치환 및 최종 프롬프트 생성
    getPrompt(taskId, data = {}) {
        const task = this.prompts[taskId];
        if (!task) {
            throw new Error(`Task [${taskId}] not found in configuration.`);
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

        // 2. 템플릿 변수 치환
        let templateContent = task.template;
        Object.keys(data).forEach(key => {
            const regex = new RegExp(`{{${key}}}`, 'g');
            templateContent = templateContent.replace(regex, data[key]);
        });

        finalPrompt += `[Content]\n${templateContent}`;

        return finalPrompt;
    }
}

export default new PromptManager();

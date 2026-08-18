/**
 * Preset: legged robot control (足式机器人控制).
 *
 * Presets are pluggable curriculum bundles — topic definition, stage
 * progression, knowledge goals and landmark seeds — so the core Literature
 * Agent stays domain-agnostic. Add a new domain (e.g. agricultural-water-soil)
 * by adding another preset file; no core code changes.
 */
import type { StageDef, TopicDef } from '../config.js'
export const LEGGED_ROBOT_TOPICS: import("../config.js").TopicDef[] = [
  {
    id: 'legged_robot_control',
    displayName: '足式机器人控制',
    canonicalQueries: [
      'legged robot locomotion control',
      'legged robot control',
      'quadruped locomotion control',
    ],
    secondaryQueries: ['dynamic legged locomotion', 'biped locomotion control'],
    negativeTerms: [
      'agricultural robot',
      'uav',
      'unmanned aerial',
      'surgical robot',
      'welding',
      'assembly line',
      'grasping',
      'manipulation',
      'landslide',
      'power grid',
    ],
  },
]

export const LEGGED_ROBOT_STAGES: import("../config.js").StageDef[] = [
  {
    label: '基础控制',
    scope: '足式机器人控制的基础概念：刚体动力学/运动学、雅可比、步态、倒立摆/ZMP、虚拟模型控制、弹簧-阻尼、模板模型（SLIP/LIPM）。',
    preferredKeywords: [
      'inverted pendulum', 'zmp', 'virtual model', 'gait', 'walking pattern',
      'dynamics', 'kinematics', 'jacobian', 'balance', 'spring', 'passive',
      'slip', 'lipm', 'template model', 'torso', 'postural', 'leg design',
      'foot placement', 'zero moment point', '步态', '倒立摆', '虚拟模型', '动力学', '运动学',
    ],
    downweightKeywords: [
      'reinforcement learning', 'deep learning', 'neural network', 'model predictive control',
      'mpc', 'perceptive', 'vision', 'perception', 'terrain', 'parkour', 'sim-to-real', 'domain randomization',
    ],
    excludeKeywords: [],
    searchQueries: [
      'legged robot dynamics',
      'locomotion control fundamentals',
      'contact dynamics legged robot',
      'impedance control legged robot',
      'whole body control legged robot',
      'inverted pendulum walking control',
      'virtual model control locomotion'
    ],
    knowledgeGoals: [
      { id: 'template_dynamics', label: 'template / simplified dynamics', keywords: ['template model', 'inverted pendulum', 'lipm', 'slip', 'spring loaded', 'centroidal', 'zmp', 'simplified model'] },
      { id: 'balance_stability', label: 'balance and stability', keywords: ['balance', 'stability', 'push recovery', 'capture point', 'postural', 'equilibrium', 'capture input', 'ankle strategy'] },
      { id: 'gait_representation', label: 'gait representation / walking pattern', keywords: ['gait', 'walking pattern', 'gait generation', 'gait synthesis', 'gait pattern', 'gait cycle', 'foot placement', 'footstep', 'step planning', 'step-to-step', 'phase', 'gait transition'] },
      { id: 'kinematics_jacobian', label: 'kinematics / jacobian', keywords: ['kinematics', 'jacobian', 'inverse kinematics', 'leg kinematics', 'kinematic model', 'workspace'] },
      { id: 'impedance_compliance', label: 'impedance / compliance', keywords: ['impedance', 'impedance control', 'compliance', 'compliance control', 'compliant', 'stiffness', 'stiffness control', 'damping', 'damper', 'spring', 'spring-damper', 'virtual spring', 'virtual model', 'force position compliance'] },
    ],
    landmarkSeeds: [
      {
        doi: '10.1177/02783640122067309',
        title: 'Virtual Model Control: An Intuitive Approach for Bipedal Locomotion',
        goals: ['impedance_compliance', 'balance_stability'],
      },
      {
        doi: '10.1109/ROBOT.2006.1641685',
        title: 'Instantaneous Capture Input for Balancing the Variable Height Inverted Pendulum',
        goals: ['template_dynamics', 'balance_stability'],
      },
    ],
    curriculumWeight: 0.35,
    requiredGoals: ['template_dynamics', 'balance_stability', 'impedance_compliance'],
  },
  {
    label: '动力学/接触控制',
    scope: '全身动力学、接触力分配、WBC、足端力/力矩控制、力位混合、摩擦锥、地面反作用力。',
    knowledgeGoals: [
      { id: 'contact_force', label: 'contact / force control', keywords: ['contact force', 'ground reaction', 'grf', 'force control', 'friction cone', 'wrench', 'reaction force'] },
      { id: 'whole_body', label: 'whole-body locomotion control', keywords: ['whole-body control', 'whole body control', 'whole body dynamics', 'full body control', 'wbc'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
    preferredKeywords: [
      'whole-body control', 'contact force', 'force distribution', 'wrench',
      'ground reaction', 'grf', 'inverse dynamics', 'hybrid force', 'friction cone',
      'contact planning', 'reaction force', 'dynamic walking', 'contact wrench',
      'force control', 'torque control', '全身控制', '接触力', '力分配',
    ],
    downweightKeywords: [
      'reinforcement learning', 'neural network', 'policy gradient', 'vision', 'perception', 'parkour',
    ],
    excludeKeywords: [],
    searchQueries: [
      'legged robot contact force control',
      'whole body control quadruped',
      'ground reaction force legged locomotion',
      'friction cone contact planning legged robot',
      'dynamic biped walking control',
      'force distribution legged robot'
    ],
  },
  {
    label: 'MPC',
    scope: '模型预测控制、轨迹优化、凸优化/QP、质心动力学、滚动时域、最优控制。',
    preferredKeywords: [
      'model predictive control', 'mpc', 'trajectory optimization', 'convex optimization',
      'quadratic program', 'qp', 'sequential quadratic', 'receding horizon', 'optimal control',
      'centroidal', 'sqp', 'lqr', 'linearized', 'whole-body mpc', 'motion planning', 'dynamics optimization',
    ],
    downweightKeywords: [
      'reinforcement learning', 'policy gradient', 'neural network', 'vision', 'perception',
    ],
    excludeKeywords: [],
    searchQueries: [
      'model predictive control legged locomotion',
      'whole body mpc quadruped',
      'trajectory optimization legged robot',
      'centroidal dynamics mpc biped',
      'receding horizon legged robot control'
    ],
    knowledgeGoals: [
      { id: 'centroidal_mpc', label: 'centroidal dynamics MPC', keywords: ['centroidal', 'model predictive control', 'mpc'] },
      { id: 'trajectory_optimization', label: 'trajectory optimization', keywords: ['trajectory optimization', 'convex optimization', 'qp', 'sqp', 'receding horizon'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
  },
  {
    label: 'RL locomotion',
    scope: '强化学习行走：PPO/SAC、奖励设计、教师-学生特权学习、领域随机化、本体感觉策略。',
    preferredKeywords: [
      'reinforcement learning', 'policy gradient', 'ppo', 'sac', 'actor-critic',
      'reward', 'teacher-student', 'privileged', 'imitation', 'locomotion learning',
      'deep rl', 'rl', 'proprioceptive', 'domain randomization', 'sim-to-real',
      'zero-shot transfer', 'asymmetric', '强化学习', '奖励',
    ],
    downweightKeywords: ['whole-body mpc', 'model predictive control', 'trajectory optimization', 'vision', 'perception'],
    excludeKeywords: [],
    searchQueries: [
      'reinforcement learning quadruped locomotion',
      'deep reinforcement learning legged locomotion',
      'teacher student policy locomotion',
      'reward design legged locomotion',
      'learning bipedal walking'
    ],
    knowledgeGoals: [
      { id: 'policy_learning', label: 'policy learning', keywords: ['reinforcement learning', 'policy gradient', 'ppo', 'actor-critic'] },
      { id: 'reward_design', label: 'reward design', keywords: ['reward', 'shaping', 'curriculum'] },
      { id: 'sim2real_rl', label: 'sim-to-real transfer', keywords: ['sim-to-real', 'domain randomization', 'zero-shot'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
  },
  {
    label: '鲁棒控制',
    scope: '抗扰/鲁棒性：外力扰动、推倒恢复、capture point、不确定性、参数摄动、故障与失稳恢复。',
    preferredKeywords: [
      'robust', 'disturbance', 'push recovery', 'capture point', 'external force',
      'perturbation', 'uncertainty', 'rejection', 'fault', 'recovery', 'impact',
      'fall', 'stability margin', 'anti-disturbance', 'adversarial', 'robustness',
      '鲁棒', '抗扰', '扰动', '推倒恢复',
    ],
    downweightKeywords: ['planning only', 'offline planning', 'map-based'],
    excludeKeywords: [],
    searchQueries: [
      'robust legged locomotion control',
      'push recovery biped robot',
      'capture point humanoid balancing',
      'disturbance rejection quadruped',
      'legged robot fall recovery'
    ],
    knowledgeGoals: [
      { id: 'push_recovery', label: 'push recovery', keywords: ['push recovery', 'capture point', 'recovery'] },
      { id: 'disturbance_rejection', label: 'disturbance rejection', keywords: ['disturbance', 'robust', 'perturbation', 'rejection'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
  },
  {
    label: 'terrain adaptation',
    scope: '地形适应：崎岖地形、台阶/楼梯、斜坡、高程图、可穿越性、感知行走、野外环境。',
    preferredKeywords: [
      'terrain', 'rough', 'stairs', 'slope', 'uneven', 'elevation', 'perceptive',
      'traversability', 'step', 'obstacle', 'parkour', 'mapping', 'point cloud',
      'exteroception', 'outdoor', 'in the wild', 'elevation map', 'blind locomotion',
      '地形', '崎岖', '楼梯', '野外', '高程图',
    ],
    downweightKeywords: [],
    excludeKeywords: [],
    searchQueries: [
      'perceptive locomotion quadruped',
      'terrain adaptation legged robot',
      'rough terrain quadruped locomotion',
      'parkour legged robot',
      'elevation mapping legged locomotion'
    ],
    knowledgeGoals: [
      { id: 'rough_terrain', label: 'rough terrain locomotion', keywords: ['terrain', 'rough', 'stairs', 'slope', 'parkour'] },
      { id: 'perception_mapping', label: 'perception / elevation mapping', keywords: ['perception', 'elevation map', 'point cloud', 'exteroception'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
  },
  {
    label: 'sim-to-real',
    scope: '仿真到真机迁移：域随机化、系统辨识、零样本部署、硬件实验、真机验证。',
    preferredKeywords: [
      'sim-to-real', 'domain randomization', 'transfer', 'reality gap', 'zero-shot',
      'simulation', 'real robot', 'deployment', 'system identification', 'hardware',
      'real-world', 'sim2real', '仿真', '真机', '迁移',
    ],
    downweightKeywords: ['simulation only', 'no hardware'],
    excludeKeywords: [],
    searchQueries: [
      'sim to real legged robot',
      'domain randomization locomotion',
      'zero shot transfer quadruped',
      'simulation to reality legged robot',
      'hardware deployment legged locomotion'
    ],
    knowledgeGoals: [
      { id: 'domain_randomization', label: 'domain randomization', keywords: ['domain randomization', 'randomization'] },
      { id: 'zero_shot_deploy', label: 'zero-shot deployment', keywords: ['zero-shot', 'deployment', 'real robot', 'hardware'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
  },
  {
    label: '前沿方法',
    scope: '前沿方法：基础模型、扩散策略、世界模型、大语言模型、通用/多任务、多模态具身智能。',
    preferredKeywords: [
      'foundation model', 'diffusion policy', 'world model', 'large language model',
      'llm', 'vision-language', 'generalist', 'multimodal', 'embodied', 'zero-shot generalization',
      '基础模型', '扩散策略', '世界模型', '具身智能',
    ],
    downweightKeywords: [],
    excludeKeywords: [],
    searchQueries: [
      'foundation model robot locomotion',
      'diffusion policy legged robot',
      'world model legged robot',
      'vision language model robot control',
      'generalist robot locomotion'
    ],
    knowledgeGoals: [
      { id: 'foundation_models', label: 'foundation models', keywords: ['foundation model', 'large language model', 'vision-language'] },
      { id: 'generative_policies', label: 'generative / world-model policies', keywords: ['diffusion policy', 'world model', 'generative'] },
    ],
    landmarkSeeds: [],
    requiredGoals: [],
  },
]

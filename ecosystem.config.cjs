module.exports = {
  apps: [
    {
      name: "backend-ts",
      script: "dist/main.js",
      cwd: "/home/prepair/prepair/backend-ts", // 라즈베리파이 배포 경로
      instances: 1, // 라즈베리파이는 싱글 인스턴스 권장
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "300M", // 라즈베리파이 메모리 제한 고려
      env: {
        NODE_ENV: "production",
        PORT: 3003,
      },
      env_production: {
        NODE_ENV: "production",
        PORT: 3003,
      },
    },
  ],
};

/**
 * 创建用户页面
 * 设计风格：医疗科技极简主义
 * - 简洁的表单设计
 * - 清晰的输入提示
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApp, UserData } from '@/contexts/AppContext';
import { User, ArrowRight, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import { nanoid } from 'nanoid';

interface CreateUserPageProps {
  onNext: () => void;
}

export default function CreateUserPage({ onNext }: CreateUserPageProps) {
  const { setCurrentUser } = useApp();
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) {
      setError('请输入用户名称');
      return;
    }

    const newUser: UserData = {
      id: nanoid(),
      name: name.trim(),
      createdAt: new Date(),
    };

    setCurrentUser(newUser);
    onNext();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md"
      >
        {/* 标题区域 */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <User className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-2">创建用户</h1>
          <p className="text-muted-foreground">
            请输入用户信息以开始足底压力采集
          </p>
        </div>

        {/* 表单卡片 */}
        <div className="medical-card">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* 用户名称 */}
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm font-medium">
                用户名称 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                type="text"
                placeholder="请输入用户名称"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError('');
                }}
                className={`h-12 ${error ? 'border-destructive' : ''}`}
              />
              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>

            {/* 创建时间（自动生成） */}
            <div className="space-y-2">
              <Label className="text-sm font-medium text-muted-foreground">
                创建时间
              </Label>
              <div className="flex items-center gap-2 h-12 px-4 bg-secondary/50 rounded-lg">
                <Calendar className="w-4 h-4 text-muted-foreground" />
                <span className="text-muted-foreground">
                  {new Date().toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            </div>

            {/* 提交按钮 */}
            <Button
              type="submit"
              className="w-full h-12 text-base group"
            >
              创建并继续
              <ArrowRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Button>
          </form>
        </div>

        {/* 提示信息 */}
        <p className="text-center text-sm text-muted-foreground mt-6">
          创建用户后，您可以开始进行足底压力数据采集
        </p>
      </motion.div>
    </div>
  );
}

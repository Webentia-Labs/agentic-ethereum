/* eslint-disable prefer-const */
"use client";
import { useState, useRef, useEffect } from "react";
import { SyncLoader } from "react-spinners";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { BrainCircuit, Send } from "lucide-react";
import { Card } from "./ui/card";
import ReactMarkdown from "react-markdown";
import { usePrivy } from "@privy-io/react-auth";
import { useParams } from "next/navigation";
import { TransferModal } from "./TransferModal";
import { toast } from "react-hot-toast";

interface Message {
  role: "user" | "assistant";
  content: string;
  sender: "user" | "assistant";
}

interface TransferData {
  tool: string;
  your_summary: string;
  parameters: {
    amount: string;
    to: string;
    txHash: string;
  };
}

export default function ChatInterface() {
  const { user } = usePrivy();
  const params = useParams();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [loadingChat, setLoadingChat] = useState(true);
  const [transferModalData, setTransferModalData] = useState<{
    data: { amount: string; to: string; txHash: string };
    message: string;
  } | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const loadMessages = async () => {
      if (!params?.chatId) return;
      setLoadingChat(true);
      try {
        const response = await fetch(`/api/chat?chatId=${params.chatId}`);
        if (!response.ok) throw new Error('Failed to load messages');
        const data = await response.json();
        
        const transformedMessages = data.map((msg: any) => ({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.content,
          sender: msg.sender
        }));
        
        setMessages(transformedMessages);
      } catch (error) {
        toast.error('Failed to load chat history');
      } finally {
        setLoadingChat(false);
      }
    };
    loadMessages();
  }, [params?.chatId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !user?.id) return;
  
    const userMessage: Message = { role: 'user', content: input, sender: 'user' };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: input,
          userId: user.id,
          chatId: params?.chatId,
          isFirstMessage: messages.length === 0
        })
      });
  
      if (!response.ok) throw new Error(await response.text());
  
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No reader available');
  
      let aiMessage: Message = { role: 'assistant', content: '', sender: 'assistant' };
      setMessages(prev => [...prev, aiMessage]);
      
      let buffer = '';
      let transferData: TransferData | null = null;
      let dbSafeMessage = ''; // This will be stored in DB
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += new TextDecoder().decode(value, { stream: true });
        
        while (buffer.includes('\n\n')) {
          const eventEndIndex = buffer.indexOf('\n\n');
          const eventData = buffer.slice(0, eventEndIndex);
          buffer = buffer.slice(eventEndIndex + 2);
          
          const lines = eventData.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const rawContent = line.slice(6).trim();
                
                if (rawContent === '[DONE]') continue;
  
                // Parse outer JSON structure
                const parsedContent = JSON.parse(rawContent);
                const agentContent = parsedContent.content;
  
                try {
                  // First try to parse as JSON
                  let agentData;
                  if (typeof agentContent === 'string') {
                    try {
                      agentData = JSON.parse(agentContent);
                    } catch {
                      // If it's not JSON, use it as plain text
                      setMessages(prev => {
                        const newMessages = [...prev];
                        const lastMessage = newMessages[newMessages.length - 1];
                        if (lastMessage.role === 'assistant') {
                          lastMessage.content = (lastMessage.content + agentContent).trim();
                        }
                        return newMessages;
                      });
                      dbSafeMessage = agentContent;
                      continue;
                    }
                  } else {
                    agentData = agentContent;
                  }
  
                  // Handle transfer data if present
                  if (agentData?.tool === 'nativeTransfer' && agentData.parameters) {
                    const formattedMessage = [
                      "✅ **Transaction Successful**",
                      "",
                      agentData.your_summary,
                      "",
                      `**Amount:** ${agentData.parameters.amount} ETH`,
                      `**To:** ${agentData.parameters.to.slice(0, 6)}...${agentData.parameters.to.slice(-4)}`,
                      `**Status:** ${agentData.parameters.txHash ? 'Completed' : 'Pending'}`
                    ].join('\n');
  
                    setMessages(prev => {
                      const newMessages = [...prev];
                      const lastMessage = newMessages[newMessages.length - 1];
                      if (lastMessage.role === 'assistant') {
                        lastMessage.content = formattedMessage;
                      }
                      return newMessages;
                    });
  
                    setTransferModalData({
                      data: {
                        amount: agentData.parameters.amount,
                        to: agentData.parameters.to,
                        txHash: agentData.parameters.txHash || 'Pending...'
                      },
                      message: agentData.your_summary
                    });
                    
                    dbSafeMessage = agentData.your_summary;
                  } else {
                    // Handle regular message
                    setMessages(prev => {
                      const newMessages = [...prev];
                      const lastMessage = newMessages[newMessages.length - 1];
                      if (lastMessage.role === 'assistant') {
                        lastMessage.content = (lastMessage.content + agentContent).trim();
                      }
                      return newMessages;
                    });
                    dbSafeMessage = agentContent;
                  }
                } catch (error) {
                  console.error('Error processing message:', error);
                  // Handle as plain text if JSON parsing fails
                  setMessages(prev => {
                    const newMessages = [...prev];
                    const lastMessage = newMessages[newMessages.length - 1];
                    if (lastMessage.role === 'assistant') {
                      lastMessage.content = (lastMessage.content + agentContent).trim();
                    }
                    return newMessages;
                  });
                  dbSafeMessage = agentContent;
                }
              } catch (error) {
                console.error('Error processing chunk:', error);
              }
            }
          }
        }
      }
  
      // Final update to ensure DB persistence
      setMessages(prev => {
        const newMessages = [...prev];
        const lastMessage = newMessages[newMessages.length - 1];
        if (lastMessage.role === 'assistant') {
          // Store only the summary in DB while keeping UI format
          lastMessage.content = dbSafeMessage;
        }
        return newMessages;
      });
  
    } catch (error) {
      console.error('Error:', error);
      toast.error('Failed to send message');
    } finally {
      setIsLoading(false);
    }
  };
  // The return statement remains the same as in your original code
  return (
    <div className="h-[calc(100vh-6rem)] bg-zinc-950 border border-zinc-800 backdrop-blur-sm rounded-t-lg overflow-hidden flex flex-col">
      {/* Messages Container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-none">
        {loadingChat ? (
          <div className="flex justify-center py-4">
            <SyncLoader color="#f97316" size={6} />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-zinc-500 text-center py-4">
            Send a message to start chatting
          </div>
        ) : (
          messages.map((message, i) => (
            <div
              key={i}
              className={`flex items-start gap-3 mx-4 md:mx-6 lg:mx-8 ${
                message.sender === 'user' ? "justify-end" : ""
              }`}
            >
              {message.sender === 'assistant' && (
                <Avatar className="h-8 w-8 bg-gradient-to-r from-red-500 to-orange-500 border border-zinc-700">
                  <AvatarFallback>
                    <BrainCircuit className="h-4 w-4" />
                  </AvatarFallback>
                </Avatar>
              )}
              
              <div
                className={`rounded-2xl p-4 max-w-[90%] md:max-w-[70%] border ${
                  message.sender === 'user'
                    ? "bg-zinc-800/80 border-blue-700"
                    : "bg-zinc-600 border-orange-700"
                }`}
              >
                <ReactMarkdown className="text-sm text-white prose-invert">
                  {message.content}
                </ReactMarkdown>
              </div>

              {message.sender === 'user' && (
                <Avatar className="h-8 w-8 border border-zinc-700">
                  <AvatarImage src={'/placeholder.svg'} />
                  <AvatarFallback>
                    {user?.email?.address?.charAt(0).toUpperCase() || 'U'}
                  </AvatarFallback>
                </Avatar>
              )}
            </div>
          ))
        )}
        {isLoading && (
          <div className="flex items-center space-x-2 mx-4 md:mx-6 lg:mx-8">
            <Avatar className="h-8 w-8 bg-gradient-to-r from-red-500 to-orange-500 border border-zinc-700">
              <AvatarFallback>
                <BrainCircuit className="h-4 w-4" />
              </AvatarFallback>
            </Avatar>
            <SyncLoader
              className="ml-2"
              color="#f97316"
              size={6}
              speedMultiplier={0.6}
            />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area - Fixed at bottom */}
      <div className="p-4 border-t border-zinc-800">
        <form onSubmit={handleSubmit} className="relative">
          <div className="flex items-center gap-2 w-full">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message..."
              className="flex-grow p-3 bg-zinc-800 border border-zinc-700 rounded text-white focus:outline-none focus:ring-2 focus:ring-orange-500 transition-colors"
              disabled={isLoading}
            />
            <button
              type="submit"
              className="bg-gradient-to-r from-red-500 to-orange-500 hover:from-red-600 hover:to-orange-600 text-white p-3 rounded aspect-square flex items-center justify-center transition-all duration-200 hover:scale-105 disabled:opacity-50"
              disabled={isLoading}
            >
              <Send className="h-5 w-5" />
            </button>
          </div>
        </form>
      </div>

      {transferModalData && (
        <TransferModal
          isOpen={true}
          onClose={() => setTransferModalData(null)}
          data={transferModalData.data}
          message={transferModalData.message}
        />
      )}
    </div>
  );
}
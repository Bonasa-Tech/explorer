import { cn } from '@components/shared/utils';
import React from 'react';

/** The label/value row primitives shared by the summary card and the cards nested inside it. */

type RowProps = React.HTMLAttributes<HTMLDivElement> & { divider?: boolean };

export function Row({ children, className, divider, ...props }: RowProps) {
    return (
        <div
            className={cn(
                'grid min-h-9 grid-cols-[clamp(100px,25%,200px)_1fr] items-baseline gap-2 px-3 py-2.5 md:px-4',
                divider && 'border-1 border-b border-white/10 [border-bottom-style:solid]',
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function Label({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn('flex flex-wrap items-center gap-1 overflow-hidden text-sm text-outer-space-300', className)}
            {...props}
        >
            {children}
        </div>
    );
}

export function Value({ children, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={cn('break-all font-mono text-sm text-white', className)} {...props}>
            {children}
        </div>
    );
}
